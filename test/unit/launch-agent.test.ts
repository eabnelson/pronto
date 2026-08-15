import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  installLaunchAgent,
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

test("installs and bootstraps one LaunchAgent", async () => {
  const directory = await mkdtemp(join(tmpdir(), "s4imsg-agent-"));
  temporaryDirectories.push(directory);
  const plistPath = join(directory, "dev.s4imsg.agent.plist");
  const calls: string[][] = [];
  const runner: LaunchctlRunner = async (args) => {
    calls.push([...args]);
    return { exitCode: args[0] === "bootout" ? 3 : 0, stderr: "", stdout: "" };
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
    ["bootstrap", "gui/501", plistPath],
    ["kickstart", "-k", "gui/501/dev.s4imsg.agent"],
  ]);
});

test("removes a partial plist when launchd bootstrap fails", async () => {
  const directory = await mkdtemp(join(tmpdir(), "s4imsg-agent-"));
  temporaryDirectories.push(directory);
  const plistPath = join(directory, "dev.s4imsg.agent.plist");

  await expect(
    installLaunchAgent({
      plist: "<?xml version=\"1.0\"?><plist></plist>\n",
      plistPath,
      runner: async (args) => ({
        exitCode: args[0] === "bootstrap" ? 1 : 0,
        stderr: "synthetic bootstrap failure",
        stdout: "",
      }),
      uid: 501,
    }),
  ).rejects.toThrow("synthetic bootstrap failure");
  await expect(readFile(plistPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
});
