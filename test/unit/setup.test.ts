import { afterEach, describe, expect, test } from "bun:test";
import { access, chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { saveConfig } from "../../src/config";
import { legacyPathsForHome, pathsForHome } from "../../src/macos/paths";
import {
  TRUST_DISCLOSURE,
  completeSetupCutover,
  createWorkspaceDirectory,
  discoverCommands,
  installSetup,
  inspectInstallation,
  loadExistingSetupDefaults,
  prepareLegacyInstallation,
  prepareSetupConfig,
  qualifyInstalledExecutable,
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
  test("gives copy-safe post-install verification steps after qualification", () => {
    const message = setupCompletionMessage(
      {
        executablePath: "/Users/example/Library/Application Support/pronto/bin/pronto",
      },
      ["@helper", "@plan"],
    );

    expect(message).toContain("Pronto installed and qualified");
    expect(message).not.toContain("Full Disk Access");
    expect(message).toContain(
      "'/Users/example/Library/Application Support/pronto/bin/pronto' status",
    );
    expect(message).toContain("@helper ping");
    expect(message).toContain("@helper, @plan");
    expect(message).toContain("tags add <tag>");
  });

  test("shell-quotes an installed status command containing an apostrophe", () => {
    const message = setupCompletionMessage(
      { executablePath: "/Users/O'Neil/Library/Application Support/pronto/bin/pronto" },
      ["@helper"],
    );

    expect(message).toContain(
      "'/Users/O'\\''Neil/Library/Application Support/pronto/bin/pronto' status",
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
        tags: ["@Helper", "@Plan"],
        workingDirectory: "/Users/example",
      }),
    ).toMatchObject({
      imsgPath: "/opt/homebrew/bin/imsg",
      primaryRuntime: "claude",
      primaryRuntimePath: "/Users/example/.local/bin/claude",
      tags: ["@helper", "@plan"],
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
        tags: ["@helper"],
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
    const missing = await resolveWorkspaceSelection("~/pronto", home);
    expect(missing).toEqual({ exists: false, path: join(home, "pronto") });
    const canonical = join(await realpath(home), "pronto");
    expect(await createWorkspaceDirectory(missing.path)).toBe(canonical);
    await chmod(missing.path, 0o755);
    const existing = await resolveWorkspaceSelection("~/pronto", home);
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
      tags: ["@s4"],
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
    await writeFile(
      path,
      JSON.stringify({
        chatKeySalt: "s".repeat(32),
        tags: ["@future"],
        version: 99,
        workingDirectory: "/Users/example/project",
      }),
    );
    await expect(loadExistingSetupDefaults(path)).rejects.toThrow(
      "Unsupported configuration version 99",
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
  await expect(access(join(home, "pronto"))).rejects.toThrow();
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
    version: 2,
    chatKeySalt: "x".repeat(32),
    imsgPath: "/usr/bin/true",
    installedExecutableHash: "not-the-current-hash",
    primaryRuntime: "codex",
    primaryRuntimePath: "/usr/bin/true",
    tags: ["@helper"],
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
      tags: ["@helper"],
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
  const compatibilityExecutable = join(paths.appSupportDirectory, "bin", "s4imsg");
  expect(await readFile(compatibilityExecutable, "utf8")).toContain("s4imsg is now Pronto");
  expect((await lstat(compatibilityExecutable)).mode & 0o777).toBe(0o700);
  expect(installed.installedExecutableHash).toHaveLength(64);
  expect(installedPlist).toContain(paths.executablePath);
  expect(await readFile(paths.configPath, "utf8")).not.toContain("@Helper");
});

test("migration retains the stopped legacy service until the Pronto cutover is finalized", async () => {
  const home = await mkdtemp(join(tmpdir(), "pronto-migration-"));
  temporaryDirectories.push(home);
  const legacyPaths = legacyPathsForHome(home);
  const paths = pathsForHome(home);
  await mkdir(join(legacyPaths.appSupportDirectory, "bin"), { recursive: true });
  await mkdir(legacyPaths.logDirectory, { recursive: true });
  await mkdir(join(home, "Library", "LaunchAgents"), { recursive: true });
  await writeFile(legacyPaths.configPath, "legacy-configuration", { mode: 0o600 });
  await writeFile(legacyPaths.databasePath, "legacy-database", { mode: 0o600 });
  await writeFile(`${legacyPaths.databasePath}-wal`, "legacy-wal", { mode: 0o600 });
  await writeFile(`${legacyPaths.databasePath}-shm`, "legacy-shm", { mode: 0o600 });
  await writeFile(legacyPaths.executablePath, "legacy-executable", { mode: 0o700 });
  await writeFile(legacyPaths.launchAgentPath, "legacy-plist", { mode: 0o600 });
  const lifecycle: string[] = [];

  const migration = await prepareLegacyInstallation({
    legacyPaths,
    paths,
    dependencies: {
      inspectLegacyAgent: async () => "running",
      stopLegacyAgent: async () => {
        lifecycle.push("stop");
      },
      restoreLegacyAgent: async () => {
        lifecycle.push("restore");
      },
      removeLegacyAgent: async (plistPath) => {
        lifecycle.push("remove");
        await rm(plistPath, { force: true });
      },
    },
  });

  expect(migration.status).toBe("migrated");
  expect(lifecycle).toEqual(["stop"]);
  expect(await readFile(legacyPaths.launchAgentPath, "utf8")).toBe("legacy-plist");
  expect(await readFile(paths.configPath, "utf8")).toBe("legacy-configuration");
  expect(await readFile(paths.databasePath, "utf8")).toBe("legacy-database");
  expect(await readFile(`${paths.databasePath}-wal`, "utf8")).toBe("legacy-wal");
  expect(await readFile(`${paths.databasePath}-shm`, "utf8")).toBe("legacy-shm");
  expect(await readFile(
    join(paths.appSupportDirectory, "migration-backup", "config.json"),
    "utf8",
  )).toBe("legacy-configuration");
  expect(await readFile(
    join(paths.appSupportDirectory, "migration-backup", "state.sqlite"),
    "utf8",
  )).toBe("legacy-database");
  expect(await readFile(
    join(paths.appSupportDirectory, "migration-backup", "state.sqlite-wal"),
    "utf8",
  )).toBe("legacy-wal");
  expect(await readFile(
    join(paths.appSupportDirectory, "migration-backup", "state.sqlite-shm"),
    "utf8",
  )).toBe("legacy-shm");
  await migration.finalize();
  expect(lifecycle).toEqual(["stop", "remove"]);
  await expect(access(legacyPaths.launchAgentPath)).rejects.toThrow();
  expect(await readFile(legacyPaths.executablePath, "utf8")).toContain(
    "s4imsg is now Pronto",
  );
  expect(await readFile(
    join(paths.appSupportDirectory, "migration-backup", "s4imsg-executable"),
    "utf8",
  )).toBe("legacy-executable");
  expect(await readFile(
    join(paths.appSupportDirectory, "migration-backup", "completed"),
    "utf8",
  )).toContain("completed");
  await writeFile(paths.configPath, "post-migration-pronto-configuration", { mode: 0o600 });
  const completedRetry = await prepareLegacyInstallation({ legacyPaths, paths });
  expect(completedRetry.status).toBe("already_migrated");
});

test("migration restores the retained legacy listener when copying state fails", async () => {
  const home = await mkdtemp(join(tmpdir(), "pronto-migration-rollback-"));
  temporaryDirectories.push(home);
  const legacyPaths = legacyPathsForHome(home);
  const paths = pathsForHome(home);
  await mkdir(legacyPaths.appSupportDirectory, { recursive: true });
  await mkdir(paths.appSupportDirectory, { recursive: true });
  await mkdir(join(home, "Library", "LaunchAgents"), { recursive: true });
  await writeFile(legacyPaths.configPath, "legacy-configuration", { mode: 0o600 });
  await writeFile(paths.configPath, "conflicting-pronto-configuration", { mode: 0o600 });
  await writeFile(legacyPaths.launchAgentPath, "legacy-plist", { mode: 0o600 });
  const lifecycle: string[] = [];

  await expect(prepareLegacyInstallation({
    legacyPaths,
    paths,
    dependencies: {
      inspectLegacyAgent: async () => "running",
      stopLegacyAgent: async () => {
        lifecycle.push("stop");
      },
      restoreLegacyAgent: async () => {
        lifecycle.push("restore");
      },
      removeLegacyAgent: async () => {
        lifecycle.push("remove");
      },
    },
  })).rejects.toThrow("conflicts");

  expect(lifecycle).toEqual(["stop", "restore"]);
  expect(await readFile(legacyPaths.launchAgentPath, "utf8")).toBe("legacy-plist");
});

test("migration rollback restarts the retained legacy listener after a later cutover failure", async () => {
  const home = await mkdtemp(join(tmpdir(), "pronto-migration-late-rollback-"));
  temporaryDirectories.push(home);
  const legacyPaths = legacyPathsForHome(home);
  const paths = pathsForHome(home);
  await mkdir(legacyPaths.appSupportDirectory, { recursive: true });
  await mkdir(join(home, "Library", "LaunchAgents"), { recursive: true });
  await writeFile(legacyPaths.configPath, "legacy-configuration", { mode: 0o600 });
  await writeFile(legacyPaths.launchAgentPath, "legacy-plist", { mode: 0o600 });
  const lifecycle: string[] = [];

  const migration = await prepareLegacyInstallation({
    legacyPaths,
    paths,
    dependencies: {
      inspectLegacyAgent: async () => "running",
      stopLegacyAgent: async () => {
        lifecycle.push("stop");
      },
      restoreLegacyAgent: async () => {
        lifecycle.push("restore");
      },
      removeLegacyAgent: async () => {
        lifecycle.push("remove");
      },
    },
  });

  await writeFile(paths.configPath, "mutated-pronto-configuration", { mode: 0o600 });
  await writeFile(`${paths.databasePath}-wal`, "new-pronto-wal", { mode: 0o600 });
  await migration.rollback();
  expect(lifecycle).toEqual(["stop", "restore"]);
  await expect(access(paths.configPath)).rejects.toThrow();
  await expect(access(`${paths.databasePath}-wal`)).rejects.toThrow();

  const retry = await prepareLegacyInstallation({
    legacyPaths,
    paths,
    dependencies: {
      inspectLegacyAgent: async () => "stopped",
      stopLegacyAgent: async () => undefined,
      restoreLegacyAgent: async () => undefined,
      removeLegacyAgent: async () => undefined,
    },
  });
  expect(retry.status).toBe("migrated");
});

test("migration resumes finalization after the legacy shim write is interrupted", async () => {
  const home = await mkdtemp(join(tmpdir(), "pronto-finalize-shim-"));
  temporaryDirectories.push(home);
  const legacyPaths = legacyPathsForHome(home);
  const paths = pathsForHome(home);
  await mkdir(join(legacyPaths.appSupportDirectory, "bin"), { recursive: true });
  await mkdir(join(home, "Library", "LaunchAgents"), { recursive: true });
  await writeFile(legacyPaths.configPath, "legacy-configuration", { mode: 0o600 });
  await writeFile(legacyPaths.executablePath, "legacy-executable", { mode: 0o700 });
  await writeFile(legacyPaths.launchAgentPath, "legacy-plist", { mode: 0o600 });

  const interrupted = await prepareLegacyInstallation({
    legacyPaths,
    paths,
    dependencies: {
      inspectLegacyAgent: async () => "running",
      installLegacyShim: async (path) => {
        await writeFile(path, "partial-shim", { mode: 0o700 });
        throw new Error("shim interruption");
      },
      stopLegacyAgent: async () => undefined,
    },
  });
  await writeFile(paths.configPath, "qualified-pronto-configuration", { mode: 0o600 });
  await expect(interrupted.finalize()).rejects.toThrow("shim interruption");

  const resumed = await prepareLegacyInstallation({
    legacyPaths,
    paths,
    dependencies: {
      inspectLegacyAgent: async () => "stopped",
      removeLegacyAgent: async (path) => rm(path, { force: true }),
    },
  });
  await resumed.finalize();

  expect(await readFile(legacyPaths.executablePath, "utf8")).toContain("s4imsg is now Pronto");
  expect(await readFile(paths.configPath, "utf8")).toBe("qualified-pronto-configuration");
});

test("migration stops an interrupted Pronto listener before restoring prepared targets", async () => {
  const home = await mkdtemp(join(tmpdir(), "pronto-prepared-resume-"));
  temporaryDirectories.push(home);
  const legacyPaths = legacyPathsForHome(home);
  const paths = pathsForHome(home);
  await mkdir(legacyPaths.appSupportDirectory, { recursive: true });
  await mkdir(join(home, "Library", "LaunchAgents"), { recursive: true });
  await writeFile(legacyPaths.configPath, "legacy-configuration", { mode: 0o600 });
  await writeFile(legacyPaths.launchAgentPath, "legacy-plist", { mode: 0o600 });

  await prepareLegacyInstallation({
    legacyPaths,
    paths,
    dependencies: {
      inspectLegacyAgent: async () => "running",
      stopLegacyAgent: async () => undefined,
    },
  });
  await writeFile(paths.configPath, "running-pronto-configuration", { mode: 0o600 });
  const lifecycle: string[] = [];

  const resumed = await prepareLegacyInstallation({
    legacyPaths,
    paths,
    dependencies: {
      inspectLegacyAgent: async () => "stopped",
      restoreLegacyAgent: async () => undefined,
      stopProntoAgent: async () => {
        lifecycle.push(`stop-pronto:${await readFile(paths.configPath, "utf8")}`);
      },
    },
  });

  expect(lifecycle).toEqual(["stop-pronto:running-pronto-configuration"]);
  expect(await readFile(paths.configPath, "utf8")).toBe("legacy-configuration");
  await resumed.rollback();
});

test("migration preserves targets and legacy shutdown state when interrupted Pronto will not stop", async () => {
  const home = await mkdtemp(join(tmpdir(), "pronto-prepared-stop-failure-"));
  temporaryDirectories.push(home);
  const legacyPaths = legacyPathsForHome(home);
  const paths = pathsForHome(home);
  await mkdir(legacyPaths.appSupportDirectory, { recursive: true });
  await mkdir(join(home, "Library", "LaunchAgents"), { recursive: true });
  await writeFile(legacyPaths.configPath, "legacy-configuration", { mode: 0o600 });
  await writeFile(legacyPaths.launchAgentPath, "legacy-plist", { mode: 0o600 });

  await prepareLegacyInstallation({
    legacyPaths,
    paths,
    dependencies: {
      inspectLegacyAgent: async () => "running",
      stopLegacyAgent: async () => undefined,
    },
  });
  await writeFile(paths.configPath, "running-pronto-configuration", { mode: 0o600 });
  let legacyRestored = false;

  await expect(prepareLegacyInstallation({
    legacyPaths,
    paths,
    dependencies: {
      inspectLegacyAgent: async () => "stopped",
      restoreLegacyAgent: async () => {
        legacyRestored = true;
      },
      stopProntoAgent: async () => {
        throw new Error("Pronto is still loaded");
      },
    },
  })).rejects.toThrow("Pronto is still loaded");

  expect(await readFile(paths.configPath, "utf8")).toBe("running-pronto-configuration");
  expect(legacyRestored).toBeFalse();
  expect(await readFile(
    join(paths.appSupportDirectory, "migration-backup", "transaction.json"),
    "utf8",
  )).toContain('"phase": "prepared"');
});

test("migration resumes finalization after legacy plist removal is interrupted", async () => {
  const home = await mkdtemp(join(tmpdir(), "pronto-finalize-plist-"));
  temporaryDirectories.push(home);
  const legacyPaths = legacyPathsForHome(home);
  const paths = pathsForHome(home);
  await mkdir(join(legacyPaths.appSupportDirectory, "bin"), { recursive: true });
  await mkdir(join(home, "Library", "LaunchAgents"), { recursive: true });
  await writeFile(legacyPaths.configPath, "legacy-configuration", { mode: 0o600 });
  await writeFile(legacyPaths.executablePath, "legacy-executable", { mode: 0o700 });
  await writeFile(legacyPaths.launchAgentPath, "legacy-plist", { mode: 0o600 });

  const interrupted = await prepareLegacyInstallation({
    legacyPaths,
    paths,
    dependencies: {
      inspectLegacyAgent: async () => "running",
      removeLegacyAgent: async (path) => {
        await rm(path, { force: true });
        throw new Error("plist interruption");
      },
      stopLegacyAgent: async () => undefined,
    },
  });
  await expect(interrupted.finalize()).rejects.toThrow("plist interruption");

  const resumed = await prepareLegacyInstallation({
    legacyPaths,
    paths,
    dependencies: {
      inspectLegacyAgent: async () => "stopped",
      removeLegacyAgent: async (path) => rm(path, { force: true }),
    },
  });
  await resumed.finalize();

  await expect(access(legacyPaths.launchAgentPath)).rejects.toThrow();
  expect(await readFile(
    join(paths.appSupportDirectory, "migration-backup", "completed"),
    "utf8",
  )).toContain("completed");
});

test("installed qualification runs doctor through the exact installed executable", async () => {
  const calls: Array<{ executable: string; args: readonly string[] }> = [];

  await qualifyInstalledExecutable(
    "/Users/example/Library/Application Support/pronto/bin/pronto",
    async (executable, args) => {
      calls.push({ executable, args });
      return { exitCode: 0, stderr: "", stdout: "ok" };
    },
  );

  expect(calls).toEqual([{
    executable: "/Users/example/Library/Application Support/pronto/bin/pronto",
    args: ["doctor"],
  }]);
});

test("cutover qualifies the installed executable before finalizing legacy removal", async () => {
  const lifecycle: string[] = [];

  await completeSetupCutover({
    install: async () => {
      lifecycle.push("install");
    },
    migration: {
      status: "migrated",
      finalize: async () => {
        lifecycle.push("finalize");
      },
      rollback: async () => {
        lifecycle.push("rollback");
      },
    },
    qualify: async () => {
      lifecycle.push("qualify-installed");
    },
    removeProntoAgent: async () => {
      lifecycle.push("remove-pronto");
    },
  });

  expect(lifecycle).toEqual(["install", "qualify-installed", "finalize"]);
});

test("cutover stops Pronto and restores legacy after installed qualification fails", async () => {
  const lifecycle: string[] = [];

  await expect(completeSetupCutover({
    install: async () => {
      lifecycle.push("install");
    },
    migration: {
      status: "migrated",
      finalize: async () => {
        lifecycle.push("finalize");
      },
      rollback: async () => {
        lifecycle.push("rollback");
      },
    },
    qualify: async () => {
      lifecycle.push("qualify-installed");
      throw new Error("qualification failed");
    },
    removeProntoAgent: async () => {
      lifecycle.push("remove-pronto");
    },
  })).rejects.toThrow("qualification failed");

  expect(lifecycle).toEqual([
    "install",
    "qualify-installed",
    "remove-pronto",
    "rollback",
  ]);
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
        tags: ["@helper"],
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
