import { join } from "node:path";

export const LAUNCH_AGENT_LABEL = "dev.s4imsg.agent";

export interface S4imsgPaths {
  appSupportDirectory: string;
  configPath: string;
  databasePath: string;
  executablePath: string;
  launchAgentPath: string;
  logDirectory: string;
  logPath: string;
}

export function pathsForHome(homeDirectory: string): S4imsgPaths {
  const appSupportDirectory = join(homeDirectory, "Library", "Application Support", "s4imsg");
  const logDirectory = join(homeDirectory, "Library", "Logs", "s4imsg");
  return {
    appSupportDirectory,
    configPath: join(appSupportDirectory, "config.json"),
    databasePath: join(appSupportDirectory, "state.sqlite"),
    executablePath: join(appSupportDirectory, "bin", "s4imsg"),
    launchAgentPath: join(
      homeDirectory,
      "Library",
      "LaunchAgents",
      `${LAUNCH_AGENT_LABEL}.plist`,
    ),
    logDirectory,
    logPath: join(logDirectory, "daemon.log"),
  };
}
