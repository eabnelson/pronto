import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  installLaunchAgent,
  installUpdaterLaunchAgent,
  parseLaunchAgentState,
  removeLaunchAgentForLabel,
  renderLaunchAgent,
  renderUpdaterLaunchAgent,
  restoreLaunchAgentForLabel,
  restartLaunchAgent,
  stopLaunchAgentForLabel,
  type LaunchctlRunner,
} from "../../packages/cli/src/macos/launch-agent";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

test("renders a stable owner LaunchAgent without shell interpolation", () => {
  const plist = renderLaunchAgent({
    executablePath: "/Users/me/Application Support/pronto/bin/pronto",
    logPath: "/Users/me/Logs/pronto/agent & output.log",
    runtimeExecutablePaths: [
      "/opt/homebrew/bin/codex",
      "/Users/me/.local/bin/claude",
      "/opt/homebrew/bin/codex",
    ],
  });

  expect(plist).toContain("dev.pronto.agent");
  expect(plist).toContain("<string>run</string>");
  expect(plist).toContain("<key>ExitTimeOut</key>\n  <integer>120</integer>");
  expect(plist).toContain("agent &amp; output.log");
  expect(plist).toContain(
    "<string>/opt/homebrew/bin:/Users/me/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>",
  );
  expect(plist).not.toContain("/bin/sh");
});

test("renders a bounded periodic updater without a keepalive loop", () => {
  const plist = renderUpdaterLaunchAgent({
    executablePath: "/Users/me/Application Support/pronto/bin/pronto",
    logPath: "/Users/me/Logs/pronto/daemon.log",
  });

  expect(plist).toContain("dev.pronto.updater");
  expect(plist).toContain("<string>update</string>");
  expect(plist).toContain("<string>--automatic</string>");
  expect(plist).toContain("<integer>21600</integer>");
  expect(plist).not.toContain("<key>RunAtLoad</key>");
  expect(plist).not.toContain("<key>KeepAlive</key>");
  expect(plist).not.toContain("/bin/sh");
});

test("distinguishes a live launchd process from a merely loaded service", () => {
  expect(parseLaunchAgentState({ exitCode: 1, stderr: "not found", stdout: "" })).toBe("stopped");
  expect(parseLaunchAgentState({ exitCode: 0, stderr: "", stdout: "state = exited\n" })).toBe(
    "loaded",
  );
  expect(
    parseLaunchAgentState({
      exitCode: 0,
      stderr: "",
      stdout: "state = running\npid = 123\n",
    }),
  ).toBe("running");
});

test("restarts the stable listener after a tag change", async () => {
  const calls: string[][] = [];
  const result = await restartLaunchAgent(async (args) => {
    calls.push([...args]);
    return { exitCode: 0, stderr: "", stdout: "" };
  }, 501);

  expect(result.exitCode).toBe(0);
  expect(calls).toEqual([["kickstart", "-k", "gui/501/dev.pronto.agent"]]);
});

test("removes the legacy service by its legacy label", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pronto-legacy-agent-"));
  temporaryDirectories.push(directory);
  const plistPath = join(directory, "dev.s4imsg.agent.plist");
  await Bun.write(plistPath, "legacy plist");
  const calls: string[][] = [];

  await removeLaunchAgentForLabel({
    label: "dev.s4imsg.agent",
    plistPath,
    runner: async (args) => {
      calls.push([...args]);
      return args[0] === "print"
        ? { exitCode: 3, stderr: "Could not find service", stdout: "" }
        : { exitCode: 0, stderr: "", stdout: "" };
    },
    uid: 501,
  });

  expect(calls).toEqual([
    ["bootout", "gui/501/dev.s4imsg.agent"],
    ["print", "gui/501/dev.s4imsg.agent"],
  ]);
  await expect(readFile(plistPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
});

test("refuses to remove a legacy plist while its service is still running", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pronto-legacy-agent-"));
  temporaryDirectories.push(directory);
  const plistPath = join(directory, "dev.s4imsg.agent.plist");
  await Bun.write(plistPath, "legacy plist");

  await expect(removeLaunchAgentForLabel({
    label: "dev.s4imsg.agent",
    plistPath,
    runner: async (args) => args[0] === "bootout"
      ? { exitCode: 1, stderr: "bootout failed", stdout: "" }
      : { exitCode: 0, stderr: "", stdout: "state = running\npid = 42\n" },
    uid: 501,
    wait: async () => undefined,
  })).rejects.toThrow("still loaded");

  expect(await readFile(plistPath, "utf8")).toBe("legacy plist");
});

test("restores a retained legacy service definition after a failed cutover", async () => {
  const calls: string[][] = [];

  await restoreLaunchAgentForLabel({
    label: "dev.s4imsg.agent",
    plistPath: "/tmp/dev.s4imsg.agent.plist",
    runner: async (args) => {
      calls.push([...args]);
      return { exitCode: 0, stderr: "", stdout: "" };
    },
    uid: 501,
  });

  expect(calls).toEqual([
    ["bootstrap", "gui/501", "/tmp/dev.s4imsg.agent.plist"],
    ["kickstart", "-k", "gui/501/dev.s4imsg.agent"],
  ]);
});

test("treats bootout as complete only after launchd can no longer print the service", async () => {
  let prints = 0;

  await stopLaunchAgentForLabel({
    label: "dev.s4imsg.agent",
    runner: async (args) => {
      if (args[0] === "print") {
        prints += 1;
        return prints === 1
          ? { exitCode: 0, stderr: "", stdout: "state = running\npid = 42\n" }
          : { exitCode: 3, stderr: "Could not find service", stdout: "" };
      }
      return { exitCode: 36, stderr: "Operation now in progress", stdout: "" };
    },
    uid: 501,
    wait: async () => undefined,
  });

  expect(prints).toBe(2);
});

test("installs and bootstraps one LaunchAgent", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pronto-agent-"));
  temporaryDirectories.push(directory);
  const plistPath = join(directory, "dev.pronto.agent.plist");
  const calls: string[][] = [];
  const runner: LaunchctlRunner = async (args) => {
    calls.push([...args]);
    return {
      exitCode: args[0] === "bootout" || args[0] === "print" ? 3 : 0,
      stderr: "",
      stdout: "",
    };
  };

  await installLaunchAgent({
    plist: "<?xml version=\"1.0\"?><plist></plist>\n",
    plistPath,
    runner,
    uid: 501,
  });

  expect(await readFile(plistPath, "utf8")).toContain("<plist>");
  expect(calls).toEqual([
    ["bootout", "gui/501/dev.pronto.agent"],
    ["print", "gui/501/dev.pronto.agent"],
    ["bootstrap", "gui/501", plistPath],
    ["kickstart", "-k", "gui/501/dev.pronto.agent"],
  ]);
});

test("installs the periodic updater without immediately kickstarting it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pronto-updater-agent-"));
  temporaryDirectories.push(directory);
  const plistPath = join(directory, "dev.pronto.updater.plist");
  const calls: string[][] = [];

  await installUpdaterLaunchAgent({
    plist: "<?xml version=\"1.0\"?><plist></plist>\n",
    plistPath,
    runner: async (args) => {
      calls.push([...args]);
      return {
        exitCode: args[0] === "bootout" || args[0] === "print" ? 3 : 0,
        stderr: "",
        stdout: "",
      };
    },
    uid: 501,
  });

  expect(calls).toEqual([
    ["bootout", "gui/501/dev.pronto.updater"],
    ["print", "gui/501/dev.pronto.updater"],
    ["bootstrap", "gui/501", plistPath],
  ]);
});

test("waits for a LaunchAgent to disappear even when bootout reports in progress", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pronto-agent-"));
  temporaryDirectories.push(directory);
  const plistPath = join(directory, "dev.pronto.agent.plist");
  const calls: string[][] = [];
  const waits: number[] = [];
  let printCalls = 0;
  const runner: LaunchctlRunner = async (args) => {
    calls.push([...args]);
    if (args[0] === "bootout") {
      return { exitCode: 36, stderr: "Operation now in progress", stdout: "" };
    }
    if (args[0] === "print") {
      printCalls += 1;
      return {
        exitCode: printCalls < 3 ? 0 : 3,
        stderr: printCalls < 3 ? "" : "Could not find service",
        stdout: printCalls < 3 ? "state = running\npid = 123\n" : "",
      };
    }
    return { exitCode: 0, stderr: "", stdout: "" };
  };

  await installLaunchAgent({
    plist: "<?xml version=\"1.0\"?><plist></plist>\n",
    plistPath,
    runner,
    uid: 501,
    wait: async (milliseconds) => {
      waits.push(milliseconds);
    },
  });

  expect(calls).toEqual([
    ["bootout", "gui/501/dev.pronto.agent"],
    ["print", "gui/501/dev.pronto.agent"],
    ["print", "gui/501/dev.pronto.agent"],
    ["print", "gui/501/dev.pronto.agent"],
    ["bootstrap", "gui/501", plistPath],
    ["kickstart", "-k", "gui/501/dev.pronto.agent"],
  ]);
  expect(waits).toEqual([100, 100]);
});

test("keeps the replacement plist and does not bootstrap when bootout times out", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pronto-agent-"));
  temporaryDirectories.push(directory);
  const plistPath = join(directory, "dev.pronto.agent.plist");
  const calls: string[][] = [];
  const waits: number[] = [];
  const runner: LaunchctlRunner = async (args) => {
    calls.push([...args]);
    return { exitCode: 0, stderr: "", stdout: "state = running\npid = 123\n" };
  };

  await expect(
    installLaunchAgent({
      plist: "<?xml version=\"1.0\"?><plist></plist>\n",
      plistPath,
      runner,
      uid: 501,
      wait: async (milliseconds) => {
        waits.push(milliseconds);
      },
    }),
  ).rejects.toThrow("run setup again");

  expect(calls.filter(([command]) => command === "print")).toHaveLength(1_250);
  expect(calls.some(([command]) => command === "bootstrap" || command === "kickstart")).toBe(
    false,
  );
  expect(waits).toHaveLength(1_249);
  expect(await readFile(plistPath, "utf8")).toContain("<plist>");
});

test("removes a partial plist when launchd bootstrap fails", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pronto-agent-"));
  temporaryDirectories.push(directory);
  const plistPath = join(directory, "dev.pronto.agent.plist");

  await expect(
    installLaunchAgent({
      plist: "<?xml version=\"1.0\"?><plist></plist>\n",
      plistPath,
      runner: async (args) => {
        if (args[0] === "bootout" || args[0] === "print") {
          return { exitCode: 3, stderr: "Could not find service", stdout: "" };
        }
        return {
          exitCode: args[0] === "bootstrap" ? 1 : 0,
          stderr: "synthetic bootstrap failure",
          stdout: "",
        };
      },
      uid: 501,
    }),
  ).rejects.toThrow("synthetic bootstrap failure");
  await expect(readFile(plistPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
});
