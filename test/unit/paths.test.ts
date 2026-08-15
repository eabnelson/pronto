import { expect, test } from "bun:test";
import { pathsForHome } from "../../src/macos/paths";

test("derives one owner-scoped service layout", () => {
  expect(pathsForHome("/Users/example")).toEqual({
    appSupportDirectory: "/Users/example/Library/Application Support/s4imsg",
    configPath: "/Users/example/Library/Application Support/s4imsg/config.json",
    databasePath: "/Users/example/Library/Application Support/s4imsg/state.sqlite",
    executablePath: "/Users/example/Library/Application Support/s4imsg/bin/s4imsg",
    launchAgentPath: "/Users/example/Library/LaunchAgents/dev.s4imsg.agent.plist",
    logDirectory: "/Users/example/Library/Logs/s4imsg",
    logPath: "/Users/example/Library/Logs/s4imsg/daemon.log",
  });
});
