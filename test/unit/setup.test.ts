import { afterEach, describe, expect, test } from "bun:test";
import { access, chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { saveConfig } from "../../src/config";
import { pathsForHome } from "../../src/macos/paths";
import {
  TRUST_DISCLOSURE,
  discoverCommands,
  installSetup,
  inspectInstallation,
  prepareSetupConfig,
  uninstallInstallation,
} from "../../src/macos/setup";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("setup discovery", () => {
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
  });
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
