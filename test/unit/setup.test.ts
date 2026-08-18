import { afterEach, describe, expect, test } from "bun:test";
import { access, chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { saveConfig } from "../../src/config";
import { pathsForHome } from "../../src/macos/paths";
import {
  TRUST_DISCLOSURE,
  createWorkspaceDirectory,
  discoverCommands,
  installSetup,
  inspectInstallation,
  loadExistingSetupDefaults,
  prepareSetupConfig,
  resolveWorkspaceSelection,
  setupCompletionMessage,
  uninstallInstallation,
} from "../../src/macos/setup";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("setup discovery", () => {
  test("gives copy-safe post-install permission and verification steps", () => {
    const message = setupCompletionMessage(
      {
        executablePath: "/Users/example/Library/Application Support/s4imsg/bin/s4imsg",
      },
      "@helper",
    );

    expect(message).toContain("s4imsg installed");
    expect(message).toContain("Full Disk Access");
    expect(message).toContain("remove and re-add");
    expect(message).toContain(
      "'/Users/example/Library/Application Support/s4imsg/bin/s4imsg' doctor",
    );
    expect(message).toContain(
      "'/Users/example/Library/Application Support/s4imsg/bin/s4imsg' status",
    );
    expect(message).toContain("@helper ping");
  });

  test("shell-quotes an installed path containing an apostrophe", () => {
    const message = setupCompletionMessage(
      { executablePath: "/Users/O'Neil/Library/Application Support/s4imsg/bin/s4imsg" },
      "@helper",
    );

    expect(message).toContain(
      "'/Users/O'\\''Neil/Library/Application Support/s4imsg/bin/s4imsg' doctor",
    );
  });

  test("accepts one runtime and records absolute command paths", () => {
    const commands = new Map([
      ["imsg", "/opt/homebrew/bin/imsg"],
      ["claude", "/Users/example/.local/bin/claude"],
    ]);
    const discovery = discoverCommands((command) => commands.get(command) ?? null);

    expect(discovery).toEqual({
      imsgPath: "/opt/homebrew/bin/imsg",
      runtimes: { claude: "/Users/example/.local/bin/claude" },
    });
    expect(
      prepareSetupConfig({
        discovery,
        primaryRuntime: "claude",
        tag: "@Helper",
        workingDirectory: "/Users/example",
      }),
    ).toMatchObject({
      imsgPath: "/opt/homebrew/bin/imsg",
      primaryRuntime: "claude",
      primaryRuntimePath: "/Users/example/.local/bin/claude",
      tag: "@helper",
    });
  });

  test("refuses setup without imsg or an installed primary runtime", () => {
    expect(() => discoverCommands(() => null)).toThrow("imsg was not found");
    expect(() =>
      prepareSetupConfig({
        discovery: {
          imsgPath: "/usr/local/bin/imsg",
          runtimes: {},
        },
        primaryRuntime: "codex",
        tag: "@helper",
        workingDirectory: "/Users/example",
      }),
    ).toThrow("Codex was not found");
  });

  test("discloses participant authority and provider data flow", () => {
    expect(TRUST_DISCLOSURE).toContain("not authentication");
    expect(TRUST_DISCLOSURE).toContain("any participant");
    expect(TRUST_DISCLOSURE).toContain("model provider");
    expect(TRUST_DISCLOSURE).toContain("untagged");
    expect(TRUST_DISCLOSURE).toContain("bypass");
    expect(TRUST_DISCLOSURE).toContain("current or future");
    expect(TRUST_DISCLOSURE).toContain("hooks");
  });

  test("resolves and creates a home-relative workspace without changing an existing folder", async () => {
    const home = await mkdtemp(join(tmpdir(), "s4imsg-workspace-"));
    temporaryDirectories.push(home);
    const missing = await resolveWorkspaceSelection("~/s4imsg", home);
    expect(missing).toEqual({ exists: false, path: join(home, "s4imsg") });
    const canonical = join(await realpath(home), "s4imsg");
    expect(await createWorkspaceDirectory(missing.path)).toBe(canonical);
    await chmod(missing.path, 0o755);
    const existing = await resolveWorkspaceSelection("~/s4imsg", home);
    expect(existing).toEqual({ exists: true, path: canonical });
    expect((await lstat(existing.path)).mode & 0o777).toBe(0o755);
  });

  test("rejects a workspace path that is an existing file", async () => {
    const home = await mkdtemp(join(tmpdir(), "s4imsg-workspace-"));
    temporaryDirectories.push(home);
    const file = join(home, "not-a-folder");
    await writeFile(file, "content");
    await expect(resolveWorkspaceSelection(file, home)).rejects.toThrow("Expected a directory");
  });

  test("preserves setup defaults from a legacy config that predates unrestricted consent", async () => {
    const home = await mkdtemp(join(tmpdir(), "s4imsg-workspace-"));
    temporaryDirectories.push(home);
    const path = join(home, "config.json");
    await writeFile(
      path,
      JSON.stringify({
        chatKeySalt: "s".repeat(32),
        selfChatHandle: "erik@example.com",
        workingDirectory: "/Users/example/project",
      }),
    );
    expect(await loadExistingSetupDefaults(path)).toEqual({
      chatKeySalt: "s".repeat(32),
      workingDirectory: "/Users/example/project",
    });
  });

  test("refuses to replace malformed existing setup state", async () => {
    const home = await mkdtemp(join(tmpdir(), "s4imsg-workspace-"));
    temporaryDirectories.push(home);
    const path = join(home, "config.json");
    await writeFile(path, "not json");
    await expect(loadExistingSetupDefaults(path)).rejects.toThrow(
      "Unable to preserve existing setup defaults",
    );
    await writeFile(path, "null");
    await expect(loadExistingSetupDefaults(path)).rejects.toThrow(
      "Unable to preserve existing setup defaults",
    );
    await writeFile(
      path,
      JSON.stringify({
        chatKeySalt: "s".repeat(32),
        workingDirectory: 42,
      }),
    );
    await expect(loadExistingSetupDefaults(path)).rejects.toThrow(
      "Unable to preserve existing setup defaults",
    );
  });
});

test("declining unrestricted consent creates no workspace or installation state", async () => {
  if (process.platform !== "darwin") return;
  const home = await mkdtemp(join(tmpdir(), "s4imsg-decline-"));
  temporaryDirectories.push(home);
  const bin = join(home, "bin");
  await mkdir(bin);
  for (const command of ["imsg", "codex"]) {
    const path = join(bin, command);
    await writeFile(path, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  }

  const repositoryRoot = join(import.meta.dir, "../..");
  const child = Bun.spawn([process.execPath, join(repositoryRoot, "src/cli.ts"), "setup"], {
    cwd: repositoryRoot,
    env: { ...process.env, HOME: home, PATH: bin },
    stdin: "pipe",
    stderr: "pipe",
    stdout: "pipe",
  });
  const stderrPromise = new Response(child.stderr).text();
  const stdoutReader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let output = "";
  const waitForPrompt = async (text: string): Promise<void> => {
    while (!output.includes(text)) {
      const chunk = await stdoutReader.read();
      if (chunk.done) throw new Error(`Setup closed before prompt: ${text}`);
      output += decoder.decode(chunk.value, { stream: true });
    }
  };
  await waitForPrompt("Trigger tag");
  child.stdin.write("\n");
  await waitForPrompt("Default working folder");
  child.stdin.write("\n");
  await waitForPrompt("Type yes to accept this trust model");
  child.stdin.write("no\n");
  child.stdin.end();
  const [exitCode, stderr] = await Promise.all([child.exited, stderrPromise]);

  expect(exitCode).toBe(1);
  expect(stderr).toContain("Setup cancelled without changing the service.");
  await expect(access(join(home, "s4imsg"))).rejects.toThrow();
  await expect(access(pathsForHome(home).configPath)).rejects.toThrow();
  await expect(access(pathsForHome(home).launchAgentPath)).rejects.toThrow();
});

test("doctor detects a replaced executable without exposing private data", async () => {
  const home = await mkdtemp(join(tmpdir(), "s4imsg-setup-"));
  temporaryDirectories.push(home);
  const paths = pathsForHome(home);
  await mkdir(join(paths.appSupportDirectory, "bin"), { recursive: true, mode: 0o700 });
  await writeFile(paths.executablePath, "original", { mode: 0o700 });
  await saveConfig(paths.configPath, {
    version: 1,
    chatKeySalt: "x".repeat(32),
    imsgPath: "/usr/bin/true",
    installedExecutableHash: "not-the-current-hash",
    primaryRuntime: "codex",
    primaryRuntimePath: "/usr/bin/true",
    tag: "@helper",
    workingDirectory: home,
    unrestrictedTrustVersion: 1,
  });
  await chmod(paths.executablePath, 0o700);

  const report = await inspectInstallation(paths, async () => ({
    exitCode: 0,
    stderr: "",
    stdout: "ok",
  }));

  expect(report.healthy).toBeFalse();
  expect(report.checks.find((check) => check.id === "executable-integrity")).toMatchObject({
    status: "failed",
  });
  expect(JSON.stringify(report)).not.toContain("@helper");
});

test("setup atomically installs a hashed executable and private configuration", async () => {
  const home = await mkdtemp(join(tmpdir(), "s4imsg-install-"));
  temporaryDirectories.push(home);
  const paths = pathsForHome(home);
  let installedPlist = "";

  const installed = await installSetup({
    config: prepareSetupConfig({
      discovery: {
        imsgPath: "/usr/bin/true",
        runtimes: { codex: "/usr/bin/true" },
      },
      primaryRuntime: "codex",
      tag: "@helper",
      workingDirectory: home,
    }),
    dependencies: {
      buildExecutable: async (outputPath) => {
        await writeFile(outputPath, "compiled-s4imsg", { mode: 0o700 });
      },
      installAgent: async ({ plist }) => {
        installedPlist = plist;
      },
    },
    paths,
  });

  expect(await readFile(paths.executablePath, "utf8")).toBe("compiled-s4imsg");
  expect((await lstat(paths.executablePath)).mode & 0o777).toBe(0o700);
  expect(installed.installedExecutableHash).toHaveLength(64);
  expect(installedPlist).toContain(paths.executablePath);
  expect(await readFile(paths.configPath, "utf8")).not.toContain("@Helper");
});

test("setup leaves the installed executable and config paired when config persistence fails", async () => {
  const home = await mkdtemp(join(tmpdir(), "s4imsg-install-"));
  temporaryDirectories.push(home);
  const paths = pathsForHome(home);
  await mkdir(join(paths.appSupportDirectory, "bin"), { recursive: true });
  await writeFile(paths.executablePath, "old-executable", { mode: 0o700 });
  await writeFile(paths.configPath, "old-config", { mode: 0o600 });

  await expect(
    installSetup({
      config: prepareSetupConfig({
        discovery: {
          imsgPath: "/usr/bin/true",
          runtimes: { codex: "/usr/bin/true" },
        },
        primaryRuntime: "codex",
        tag: "@helper",
        workingDirectory: home,
      }),
      dependencies: {
        buildExecutable: async (outputPath) => {
          await writeFile(outputPath, "new-executable", { mode: 0o700 });
        },
        installAgent: async () => undefined,
        saveConfiguration: async () => {
          throw new Error("synthetic config failure");
        },
      },
      paths,
    }),
  ).rejects.toThrow("synthetic config failure");

  expect(await readFile(paths.executablePath, "utf8")).toBe("old-executable");
  expect(await readFile(paths.configPath, "utf8")).toBe("old-config");
});

test("uninstall removes the service executable but retains private data by default", async () => {
  const home = await mkdtemp(join(tmpdir(), "s4imsg-uninstall-"));
  temporaryDirectories.push(home);
  const paths = pathsForHome(home);
  await mkdir(join(paths.appSupportDirectory, "bin"), { recursive: true });
  await writeFile(paths.executablePath, "binary");
  await writeFile(paths.configPath, "configuration");
  await writeFile(paths.databasePath, "database");
  let agentRemoved = false;

  await uninstallInstallation({
    paths,
    removeAgent: async () => {
      agentRemoved = true;
    },
  });

  expect(agentRemoved).toBeTrue();
  await expect(access(paths.executablePath)).rejects.toThrow();
  expect(await readFile(paths.configPath, "utf8")).toBe("configuration");
  expect(await readFile(paths.databasePath, "utf8")).toBe("database");
});

test("confirmed purge removes private state and logs", async () => {
  const home = await mkdtemp(join(tmpdir(), "s4imsg-purge-"));
  temporaryDirectories.push(home);
  const paths = pathsForHome(home);
  await mkdir(paths.appSupportDirectory, { recursive: true });
  await mkdir(paths.logDirectory, { recursive: true });
  await writeFile(paths.configPath, "configuration");
  await writeFile(paths.logPath, "content-free log");

  await uninstallInstallation({ paths, purge: true, removeAgent: async () => undefined });

  await expect(access(paths.appSupportDirectory)).rejects.toThrow();
  await expect(access(paths.logDirectory)).rejects.toThrow();
});
