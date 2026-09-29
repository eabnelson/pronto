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
  /** The optional menu bar app, installed per user. */
  menubarAppPath: string;
  providerStatePath: string;
  updateBackupPath: string;
  updateDatabaseBackupPath: string;
  updateDirectory: string;
  updateLockPath: string;
  updateStatePath: string;
  updaterLaunchAgentPath: string;
  whatsappStatePath: string;
  whatsappStoreDirectory: string;
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
    menubarAppPath: join(input.homeDirectory, "Applications", "Pronto.app"),
    providerStatePath: join(appSupportDirectory, "provider-state.json"),
    updateBackupPath: join(updateDirectory, "last-known-good"),
    updateDatabaseBackupPath: join(updateDirectory, "last-known-good-state.sqlite"),
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
    whatsappStatePath: join(appSupportDirectory, "whatsapp-state.json"),
    whatsappStoreDirectory: join(appSupportDirectory, "whatsapp"),
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
