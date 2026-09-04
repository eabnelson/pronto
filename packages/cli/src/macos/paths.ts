import { join } from "node:path";

export const LAUNCH_AGENT_LABEL = "dev.pronto.agent";
export const UPDATER_LAUNCH_AGENT_LABEL = "dev.pronto.updater";
export const LEGACY_LAUNCH_AGENT_LABEL = "dev.s4imsg.agent";

export interface ProntoPaths {
  appSupportDirectory: string;
  configPath: string;
  databasePath: string;
  executablePath: string;
  launchAgentPath: string;
  logDirectory: string;
  logPath: string;
  providerStatePath: string;
  updateBackupPath: string;
  updateDirectory: string;
  updateLockPath: string;
  updateStatePath: string;
  updaterLaunchAgentPath: string;
}

function productPathsForHome(input: {
  executable: string;
  homeDirectory: string;
  label: string;
  product: string;
}): ProntoPaths {
  const appSupportDirectory = join(
    input.homeDirectory,
    "Library",
    "Application Support",
    input.product,
  );
  const logDirectory = join(input.homeDirectory, "Library", "Logs", input.product);
  const updateDirectory = join(appSupportDirectory, "updates");
  return {
    appSupportDirectory,
    configPath: join(appSupportDirectory, "config.json"),
    databasePath: join(appSupportDirectory, "state.sqlite"),
    executablePath: join(appSupportDirectory, "bin", input.executable),
    launchAgentPath: join(
      input.homeDirectory,
      "Library",
      "LaunchAgents",
      `${input.label}.plist`,
    ),
    logDirectory,
    logPath: join(logDirectory, "daemon.log"),
    providerStatePath: join(appSupportDirectory, "provider-state.json"),
    updateBackupPath: join(updateDirectory, "last-known-good"),
    updateDirectory,
    updateLockPath: join(updateDirectory, "update.lock"),
    updateStatePath: join(updateDirectory, "state.json"),
    updaterLaunchAgentPath: join(
      input.homeDirectory,
      "Library",
      "LaunchAgents",
      input.label === LAUNCH_AGENT_LABEL
        ? `${UPDATER_LAUNCH_AGENT_LABEL}.plist`
        : `${input.label}.updater.plist`,
    ),
  };
}

export function pathsForHome(homeDirectory: string): ProntoPaths {
  return productPathsForHome({
    executable: "pronto",
    homeDirectory,
    label: LAUNCH_AGENT_LABEL,
    product: "pronto",
  });
}

export function legacyPathsForHome(homeDirectory: string): ProntoPaths {
  return productPathsForHome({
    executable: "s4imsg",
    homeDirectory,
    label: LEGACY_LAUNCH_AGENT_LABEL,
    product: "s4imsg",
  });
}
