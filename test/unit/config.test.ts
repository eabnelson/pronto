import { afterEach, describe, expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  addTag,
  createConfig,
  loadConfig,
  normalizeTag,
  normalizeTags,
  removeTag,
  saveConfig,
  UNRESTRICTED_TRUST_VERSION,
} from "../../packages/cli/src/config";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("trigger tag validation", () => {
  test("adds one optional @ and normalizes tags for case-insensitive matching", () => {
    expect(normalizeTag("Helper_1")).toBe("@helper_1");
    expect(normalizeTag("@Helper_1")).toBe("@helper_1");
  });

  test("rejects unbounded or ambiguous tags", () => {
    for (const tag of ["@", "@@helper", "@two words", "@tool!", `@${"a".repeat(33)}`]) {
      expect(() => normalizeTag(tag)).toThrow("Tag must match");
    }
  });

  test("normalizes, deduplicates, adds, and removes any number of tags", () => {
    expect(normalizeTags(["Helper", "@PLAN", "@helper"])).toEqual([
      "@helper",
      "@plan",
    ]);
    expect(addTag(["@helper"], "Plan")).toEqual(["@helper", "@plan"]);
    expect(addTag(["@helper"], "HELPER")).toEqual(["@helper"]);
    expect(removeTag(["@helper", "@plan"], "HELPER")).toEqual(["@plan"]);
    expect(() => removeTag(["@helper"], "@helper")).toThrow("last tag");
  });
});

describe("configuration persistence", () => {
  test("requires distinct primary and fallback runtimes", () => {
    expect(() =>
      createConfig({
        fallbackRuntime: "codex",
        imsgPath: "/opt/homebrew/bin/imsg",
        primaryRuntime: "codex",
        tags: ["@helper"],
        unrestrictedTrustVersion: UNRESTRICTED_TRUST_VERSION,
        workingDirectory: "/Users/example",
      }),
    ).toThrow("Fallback runtime must differ");
  });

  test("round-trips owner-private configuration atomically", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pronto-config-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "nested", "config.json");
    const config = createConfig({
      fallbackRuntime: "claude",
      imsgPath: "/opt/homebrew/bin/imsg",
      primaryRuntime: "codex",
      tags: ["@Helper", "@Plan"],
      unrestrictedTrustVersion: UNRESTRICTED_TRUST_VERSION,
      workingDirectory: "/Users/example",
    });

    await saveConfig(path, config);

    expect(await loadConfig(path)).toEqual(config);
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
    expect((await lstat(join(directory, "nested"))).mode & 0o777).toBe(0o700);
  });

  test("ignores the removed manual self-chat field in an existing configuration", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pronto-config-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "config.json");
    await Bun.write(path, JSON.stringify({
      version: 1,
      chatKeySalt: "x".repeat(32),
      imsgPath: "/usr/local/bin/imsg",
      primaryRuntime: "codex",
      selfChatHandle: 42,
      tag: "@helper",
      unrestrictedTrustVersion: UNRESTRICTED_TRUST_VERSION,
      workingDirectory: "/Users/example",
    }));

    expect(await loadConfig(path)).toMatchObject({ tags: ["@helper"], version: 2 });
    expect(await loadConfig(path)).not.toHaveProperty("selfChatHandle");
  });

  test("rejects legacy configuration without unrestricted access consent", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pronto-config-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "config.json");
    await Bun.write(path, JSON.stringify({
      version: 1,
      chatKeySalt: "x".repeat(32),
      imsgPath: "/usr/local/bin/imsg",
      primaryRuntime: "codex",
      tag: "@helper",
      workingDirectory: "/Users/example",
    }));
    await expect(loadConfig(path)).rejects.toThrow("run pronto setup");
  });

  test("rejects a symlinked configuration directory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pronto-config-"));
    temporaryDirectories.push(directory);
    const actual = join(directory, "actual");
    await Bun.write(join(actual, ".keep"), "");
    await chmod(actual, 0o700);
    await Bun.$`ln -s ${actual} ${join(directory, "linked")}`.quiet();

    await expect(
      saveConfig(
        join(directory, "linked", "config.json"),
        createConfig({
          imsgPath: "/usr/local/bin/imsg",
          primaryRuntime: "claude",
          tags: ["@helper"],
          unrestrictedTrustVersion: UNRESTRICTED_TRUST_VERSION,
          workingDirectory: "/Users/example",
        }),
      ),
    ).rejects.toThrow("symbolic link");
  });

  test("tightens an existing configuration directory to owner-only access", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pronto-config-"));
    temporaryDirectories.push(directory);
    const stateDirectory = join(directory, "state");
    await mkdir(stateDirectory, { mode: 0o755 });

    await saveConfig(
      join(stateDirectory, "config.json"),
      createConfig({
        imsgPath: "/usr/local/bin/imsg",
        primaryRuntime: "codex",
        tags: ["@helper"],
        unrestrictedTrustVersion: UNRESTRICTED_TRUST_VERSION,
        workingDirectory: "/Users/example",
      }),
    );

    expect((await lstat(stateDirectory)).mode & 0o777).toBe(0o700);
  });

  test("does not change permissions on existing ancestor directories", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pronto-config-"));
    temporaryDirectories.push(directory);
    await chmod(directory, 0o755);

    await saveConfig(
      join(directory, "private", "config.json"),
      createConfig({
        imsgPath: "/usr/local/bin/imsg",
        primaryRuntime: "codex",
        tags: ["@helper"],
        unrestrictedTrustVersion: UNRESTRICTED_TRUST_VERSION,
        workingDirectory: "/Users/example",
      }),
    );

    expect((await lstat(directory)).mode & 0o777).toBe(0o755);
    expect((await lstat(join(directory, "private"))).mode & 0o777).toBe(0o700);
  });
});
