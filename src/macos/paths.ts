import { join } from "node:path";

export const LAUNCH_AGENT_LABEL = "dev.pronto.agent";
export const LEGACY_LAUNCH_AGENT_LABEL = "dev.s4imsg.agent";

export interface ProntoPaths {
  appSupportDirectory: string;
  configPath: string;
  databasePath: string;
  executablePath: string;
  launchAgentPath: string;
  logDirectory: string;
  logPath: string;
}

export function pathsForHome(homeDirectory: string): ProntoPaths {
  const appSupportDirectory = join(homeDirectory, "Library", "Application Support", "pronto");
  const logDirectory = join(homeDirectory, "Library", "Logs", "pronto");
  return {
    appSupportDirectory,
    configPath: join(appSupportDirectory, "config.json"),
    databasePath: join(appSupportDirectory, "state.sqlite"),
    executablePath: join(appSupportDirectory, "bin", "pronto"),
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

export function legacyPathsForHome(homeDirectory: string): ProntoPaths {
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
      `${LEGACY_LAUNCH_AGENT_LABEL}.plist`,
    ),
    logDirectory,
    logPath: join(logDirectory, "daemon.log"),
  };
}
