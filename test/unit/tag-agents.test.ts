import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfig, loadConfig, removeTagFromApps, runtimeSelection, saveConfig, setTagRuntimes } from "../../packages/cli/src/config";
import { pathsForHome } from "../../packages/cli/src/macos/paths";
import { loadExistingSetupDefaults } from "../../packages/cli/src/macos/setup";
import { runtimeChainForTag } from "../../packages/cli/src/runtimes/selection";
import { editTagAgents, tagsResponse } from "../../packages/cli/src/tag-agents";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "pronto-tag-agents-"));
  directories.push(home);
  const primaryRuntimePath = join(home, "codex");
  const fallbackRuntimePath = join(home, "claude");
  for (const path of [primaryRuntimePath, fallbackRuntimePath]) await writeFile(path, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  const config = createConfig({
    channels: {
      imessage: { enabled: true, imsgPath: "/usr/local/bin/imsg", tags: ["@chat", "@work"] },
      slack: { enabled: true, riskConsentVersion: 1, tags: ["@work", "@other"] },
    },
    primaryRuntime: "codex", fallbackRuntime: "claude", primaryRuntimePath, fallbackRuntimePath,
    workingDirectory: home, unrestrictedTrustVersion: 1,
  });
  return { home, config, path: pathsForHome(home).configPath };
}

test("tag agent choices persist across reload and setup, inherit by default, and route with pinned paths", async () => {
  const { config, path } = await fixture();
  const next = await editTagAgents(config, ["WORK", "--primary", "claude", "--backup", "codex"]);
  await saveConfig(path, next);
  const reloaded = await loadConfig(path);
  expect((await loadExistingSetupDefaults(path))?.tagRuntimes).toEqual(next.tagRuntimes);
  expect(runtimeSelection(reloaded, "@chat").primaryRuntime).toBe("codex");
  expect(runtimeSelection(reloaded).primaryRuntime).toBe("codex"); // Legacy queued turns.
  const chain = runtimeChainForTag(reloaded, "@work");
  expect(chain.primary.kind).toBe("claude");
  expect(chain.primary.executablePath).toBe(config.fallbackRuntimePath!);
  expect(chain.fallback?.kind).toBe("codex");
  const response = await tagsResponse(reloaded);
  expect(response.tags.find((entry) => entry.tag === "@work")).toEqual({
    tag: "@work", apps: ["imessage", "slack"], agents: { primary: "claude", backup: "codex", inherited: false },
  });
  expect(response.availableAgents.every((agent) => agent.available)).toBeTrue();
  const noBackup = await editTagAgents(next, ["@work", "--primary", "claude", "--backup", "none"]);
  expect(runtimeChainForTag(noBackup, "@work").fallback).toBeUndefined();
  const reset = await editTagAgents(noBackup, ["@work", "--reset"]);
  expect((await tagsResponse(reset)).tags.find((entry) => entry.tag === "@work")?.agents).toEqual({ primary: "codex", backup: "claude", inherited: true });
});

test("an override survives removal from one app and is removed with the tag's final assignment", async () => {
  const { config } = await fixture();
  const selected = await editTagAgents(config, ["@work", "--primary", "claude", "--backup", "none"]);
  const partial = removeTagFromApps(selected, "@work", ["imessage"]);
  expect(partial.tagRuntimes?.["@work"]?.primaryRuntime).toBe("claude");
  const removed = removeTagFromApps(partial, "@work", ["slack"]);
  expect(removed.tagRuntimes?.["@work"]).toBeUndefined();
});

test("invalid and partial choices never change the configuration", async () => {
  const { config, path } = await fixture();
  for (const args of [
    ["@work", "--primary", "codex", "--backup", "codex"],
    ["@work", "--primary", "claude"],
    ["@work", "--primary", "unknown", "--backup", "none"],
    ["@work", "--primary", "claude", "--backup", "none", "--backup", "codex"],
    ["@work", "--reset", "--primary", "codex"],
    ["@missing", "--reset"],
  ]) await expect(editTagAgents(config, args)).rejects.toThrow();
  expect(config.tagRuntimes).toBeUndefined();
  expect(() => setTagRuntimes(config, "@work", { primaryRuntime: "claude", primaryRuntimePath: "relative" })).toThrow("absolute");
  await saveConfig(path, { ...config, tagRuntimes: { "@work": { primaryRuntime: "claude", fallbackRuntime: "claude" } } });
  await expect(loadConfig(path)).rejects.toThrow("differ");
  await saveConfig(path, { ...config, tagRuntimes: { "@missing": { primaryRuntime: "claude" } } });
  await expect(loadConfig(path)).rejects.toThrow("unconfigured");
});

test("the installed CLI contract saves and resets one tag without changing other settings", async () => {
  const { home, config, path } = await fixture();
  await saveConfig(path, config);
  const run = async (args: string[]) => {
    const child = Bun.spawn([process.execPath, "packages/cli/src/cli.ts", "tags", "agents", "@work", ...args, "--json"], {
      cwd: join(import.meta.dir, "../.."), env: { ...process.env, HOME: home }, stdout: "pipe", stderr: "pipe",
    });
    const [code, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
    return { code, result: JSON.parse(stdout) };
  };
  const saved = await run(["--primary", "claude", "--backup", "none"]);
  expect(saved.code).toBe(0);
  expect(saved.result.tags.find((entry: { tag: string }) => entry.tag === "@work").agents).toEqual({ primary: "claude", backup: null, inherited: false });
  const edited = await loadConfig(path);
  expect(edited.channels).toEqual(config.channels);
  expect(edited.primaryRuntime).toBe(config.primaryRuntime);
  expect(edited.chatKeySalt).toBe(config.chatKeySalt);
  const invalid = await run(["--primary", "claude", "--backup", "claude"]);
  expect(invalid.code).toBe(2);
  expect(invalid.result.error).toContain("differ");
  expect(await loadConfig(path)).toEqual(edited);
  expect((await run(["--reset"])).code).toBe(0);
  expect((await loadConfig(path)).tagRuntimes).toEqual({});
});
