import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  installLaunchAgent,
  parseLaunchAgentState,
  renderLaunchAgent,
  type LaunchctlRunner,
} from "../../src/macos/launch-agent";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

test("renders a stable owner LaunchAgent without shell interpolation", () => {
  const plist = renderLaunchAgent({
    executablePath: "/Users/me/Application Support/s4imsg/bin/s4imsg",
    logPath: "/Users/me/Logs/s4imsg/agent & output.log",
  });

  expect(plist).toContain("dev.s4imsg.agent");
  expect(plist).toContain("<string>run</string>");
  expect(plist).toContain("agent &amp; output.log");
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

test("installs and bootstraps one LaunchAgent", async () => {
  const directory = await mkdtemp(join(tmpdir(), "s4imsg-agent-"));
  temporaryDirectories.push(directory);
  const plistPath = join(directory, "dev.s4imsg.agent.plist");
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
    ["bootout", "gui/501/dev.s4imsg.agent"],
    ["print", "gui/501/dev.s4imsg.agent"],
    ["bootstrap", "gui/501", plistPath],
    ["kickstart", "-k", "gui/501/dev.s4imsg.agent"],
  ]);
});

test("waits for a LaunchAgent to disappear even when bootout reports in progress", async () => {
  const directory = await mkdtemp(join(tmpdir(), "s4imsg-agent-"));
  temporaryDirectories.push(directory);
  const plistPath = join(directory, "dev.s4imsg.agent.plist");
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
    ["bootout", "gui/501/dev.s4imsg.agent"],
    ["print", "gui/501/dev.s4imsg.agent"],
    ["print", "gui/501/dev.s4imsg.agent"],
    ["print", "gui/501/dev.s4imsg.agent"],
    ["bootstrap", "gui/501", plistPath],
    ["kickstart", "-k", "gui/501/dev.s4imsg.agent"],
  ]);
  expect(waits).toEqual([100, 100]);
});

test("keeps the replacement plist and does not bootstrap when bootout times out", async () => {
  const directory = await mkdtemp(join(tmpdir(), "s4imsg-agent-"));
  temporaryDirectories.push(directory);
  const plistPath = join(directory, "dev.s4imsg.agent.plist");
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

  expect(calls.filter(([command]) => command === "print")).toHaveLength(50);
  expect(calls.some(([command]) => command === "bootstrap" || command === "kickstart")).toBe(
    false,
  );
  expect(waits).toHaveLength(49);
  expect(await readFile(plistPath, "utf8")).toContain("<plist>");
});

test("removes a partial plist when launchd bootstrap fails", async () => {
  const directory = await mkdtemp(join(tmpdir(), "s4imsg-agent-"));
  temporaryDirectories.push(directory);
  const plistPath = join(directory, "dev.s4imsg.agent.plist");

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
