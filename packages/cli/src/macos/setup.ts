import { access, chmod, copyFile, mkdir, readFile, realpath, rename, rm, stat, unlink } from "node:fs/promises";
import { constants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import {
  atomicWritePrivate,
  createConfig,
  ensurePrivateDirectory,
  loadConfig,
  normalizeTags,
  saveConfig,
  type RuntimeKind,
  type ProntoConfig,
  UNRESTRICTED_TRUST_VERSION,
} from "../config";
import {
  installLaunchAgent,
  launchAgentStateForLabel,
  removeLaunchAgent,
  removeLaunchAgentForLabel,
  renderLaunchAgent,
  restoreLaunchAgentForLabel,
  stopLaunchAgentForLabel,
  type LaunchAgentState,
  type ProcessResult,
} from "./launch-agent";
import { LAUNCH_AGENT_LABEL, LEGACY_LAUNCH_AGENT_LABEL, type ProntoPaths } from "./paths";
import { renderCompatibilityLauncher } from "../compatibility";

export const TRUST_DISCLOSURE = `The trigger tag is not authentication: any participant, current or future, in an eligible iMessage or RCS conversation can instruct your selected local agent. Claude Code and Codex will bypass their approval and sandbox prompts and can run commands or change files anywhere this macOS user can access. Adding a participant or eligible chat does not ask for consent again; untagged messages and attachments are untrusted evidence but may still influence the model. A selected folder's project instructions, hooks, and MCP servers may also run with this unrestricted access. Conversation material may be sent to your selected model provider. You are responsible for informing participants.`;

export interface WorkspaceSelection {
  exists: boolean;
  path: string;
}

export interface ExistingSetupDefaults {
  chatKeySalt: string;
  tags: string[];
  workingDirectory: string;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function setupCompletionMessage(
  paths: Pick<ProntoPaths, "executablePath">,
  tags: readonly string[],
): string {
  const executable = shellQuote(paths.executablePath);
  return `Pronto installed and qualified.

Next steps:
1. Confirm the background listener is ready:
   ${executable} status
2. Send ${tags[0]} ping in an iMessage or RCS chat where this Mac owner has already sent a message.

Configured tags: ${tags.join(", ")}
Add or remove tags later with ${executable} tags add <tag> and ${executable} tags remove <tag>.`;
}

export function fullDiskAccessInstructions(executablePath: string): string {
  return `Before setup can finish, grant Full Disk Access to this exact file:
${executablePath}
If Pronto already appears in Full Disk Access, remove the existing pronto row and add this exact file again. Toggling the existing row off and on is not enough after the executable has been replaced.`;
}

export async function loadExistingSetupDefaults(
  configPath: string,
): Promise<ExistingSetupDefaults | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(configPath, "utf8"));
    if (parsed === null || typeof parsed !== "object") {
      throw new Error("existing configuration is not an object");
    }
    const value = parsed as Record<string, unknown>;
    let tags: string[] | null;
    if (value.version === undefined) {
      tags = ["@s4"];
    } else if (value.version === 1) {
      tags = typeof value.tag === "string" ? normalizeTags([value.tag]) : null;
    } else if (value.version === 2) {
      tags = Array.isArray(value.tags) && value.tags.every((tag) => typeof tag === "string")
        ? normalizeTags(value.tags)
        : null;
    } else {
      throw new Error(`Unsupported configuration version ${String(value.version)}`);
    }
    if (
      typeof value.chatKeySalt !== "string" ||
      value.chatKeySalt.length < 32 ||
      tags === null ||
      typeof value.workingDirectory !== "string" ||
      !isAbsolute(value.workingDirectory)
    ) {
      throw new Error("existing configuration is missing stable setup defaults");
    }
    return {
      chatKeySalt: value.chatKeySalt,
      tags,
      workingDirectory: value.workingDirectory,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(`Unable to preserve existing setup defaults: ${(error as Error).message}`);
  }
}

export interface LegacyMigration {
  status: "not_found" | "already_migrated" | "migrated";
  finalize: () => Promise<void>;
  rollback: () => Promise<void>;
}

interface LegacyMigrationDependencies {
  inspectLegacyAgent: () => Promise<LaunchAgentState>;
  installLegacyShim: (executablePath: string) => Promise<void>;
  removeLegacyAgent: (plistPath: string) => Promise<void>;
  restoreLegacyAgent: (plistPath: string) => Promise<void>;
  stopLegacyAgent: () => Promise<void>;
  stopProntoAgent: () => Promise<void>;
}

export async function prepareLegacyInstallation(input: {
  legacyPaths: ProntoPaths;
  paths: ProntoPaths;
  dependencies?: Partial<LegacyMigrationDependencies>;
}): Promise<LegacyMigration> {
  const exists = async (path: string): Promise<boolean> => {
    try {
      await access(path);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  };
  const backupDirectory = join(input.paths.appSupportDirectory, "migration-backup");
  const completionMarker = join(backupDirectory, "completed");
  const statePath = join(backupDirectory, "transaction.json");
  const rollbackDirectory = join(backupDirectory, "pronto-before-cutover");
  const targets = [
    input.paths.configPath,
    input.paths.databasePath,
    `${input.paths.databasePath}-wal`,
    `${input.paths.databasePath}-shm`,
  ];
  if (await exists(completionMarker)) {
    return {
      status: "already_migrated",
      finalize: async () => undefined,
      rollback: async () => undefined,
    };
  }
  const dependencies: LegacyMigrationDependencies = {
    inspectLegacyAgent: () => launchAgentStateForLabel({ label: LEGACY_LAUNCH_AGENT_LABEL }),
    installLegacyShim: async (executablePath) => {
      await atomicWritePrivate(
        executablePath,
        renderCompatibilityLauncher(input.paths.executablePath),
      );
      await chmod(executablePath, 0o700);
    },
    removeLegacyAgent: (plistPath) => removeLaunchAgentForLabel({
      label: LEGACY_LAUNCH_AGENT_LABEL,
      plistPath,
    }),
    restoreLegacyAgent: (plistPath) => restoreLaunchAgentForLabel({
      label: LEGACY_LAUNCH_AGENT_LABEL,
      plistPath,
    }),
    stopLegacyAgent: () => stopLaunchAgentForLabel({ label: LEGACY_LAUNCH_AGENT_LABEL }),
    stopProntoAgent: () => stopLaunchAgentForLabel({ label: LAUNCH_AGENT_LABEL }),
    ...input.dependencies,
  };
  type TransactionState = {
    legacyExecutableExisted: boolean;
    legacyPlistExisted: boolean;
    phase: "preparing" | "prepared" | "finalizing";
    restoreLegacyOnRollback: boolean;
    targetPresence: Record<string, boolean>;
    version: 1;
  };
  const storedState = await readFile(statePath, "utf8")
    .then((contents) => JSON.parse(contents) as TransactionState)
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
  if (storedState !== null && storedState.version !== 1) {
    throw new Error("Unsupported Pronto migration transaction version");
  }
  const legacyAgentState = await dependencies.inspectLegacyAgent();
  const legacyConfigExists = await exists(input.legacyPaths.configPath);
  const legacyAgentExists = await exists(input.legacyPaths.launchAgentPath);
  const legacyArtifacts = [
    ...(legacyConfigExists
      ? [{ source: input.legacyPaths.configPath, target: input.paths.configPath }]
      : []),
    ...await Promise.all(
      ["", "-wal", "-shm"].map(async (suffix) => {
        const source = `${input.legacyPaths.databasePath}${suffix}`;
        return await exists(source)
          ? { source, target: `${input.paths.databasePath}${suffix}` }
          : undefined;
      }),
    ).then((artifacts) => artifacts.filter((artifact) => artifact !== undefined)),
  ];
  if (
    storedState === null &&
    legacyArtifacts.length === 0 &&
    !legacyAgentExists &&
    legacyAgentState === "stopped"
  ) {
    return {
      status: "not_found",
      finalize: async () => undefined,
      rollback: async () => undefined,
    };
  }
  if (storedState === null && legacyAgentState !== "stopped" && !legacyAgentExists) {
    throw new Error(
      "The legacy s4imsg service is loaded but its LaunchAgent plist is missing; restore the plist before migrating",
    );
  }
  await ensurePrivateDirectory(input.paths.appSupportDirectory);
  await ensurePrivateDirectory(backupDirectory);
  await ensurePrivateDirectory(rollbackDirectory);
  let state = storedState;
  if (state === null) {
    const targetPresence = Object.fromEntries(
      await Promise.all(targets.map(async (target) => [target, await exists(target)] as const)),
    );
    for (const target of targets) {
      if (!targetPresence[target]) continue;
      const backup = join(rollbackDirectory, basename(target));
      await copyFile(target, backup);
      await chmod(backup, 0o600);
    }
    const legacyExecutableExisted = await exists(input.legacyPaths.executablePath);
    if (legacyExecutableExisted) {
      await copyFile(
        input.legacyPaths.executablePath,
        join(backupDirectory, "s4imsg-executable"),
      );
      await chmod(join(backupDirectory, "s4imsg-executable"), 0o700);
    }
    if (legacyAgentExists) {
      await copyFile(
        input.legacyPaths.launchAgentPath,
        join(backupDirectory, "s4imsg-launch-agent.plist"),
      );
      await chmod(join(backupDirectory, "s4imsg-launch-agent.plist"), 0o600);
    }
    state = {
      legacyExecutableExisted,
      legacyPlistExisted: legacyAgentExists,
      phase: "preparing",
      restoreLegacyOnRollback: legacyAgentState !== "stopped",
      targetPresence,
      version: 1,
    };
    await atomicWritePrivate(statePath, `${JSON.stringify(state, null, 2)}\n`);
  }
  const restoreTargets = async (): Promise<void> => {
    for (const target of targets) {
      if (state.targetPresence[target] === true) {
        await copyFile(join(rollbackDirectory, basename(target)), target);
        await chmod(target, 0o600);
      } else {
        await rm(target, { force: true });
      }
    }
  };
  const restoreLegacyFiles = async (): Promise<void> => {
    if (state.legacyExecutableExisted) {
      await copyFile(
        join(backupDirectory, "s4imsg-executable"),
        input.legacyPaths.executablePath,
      );
      await chmod(input.legacyPaths.executablePath, 0o700);
    } else {
      await rm(input.legacyPaths.executablePath, { force: true });
    }
    if (state.legacyPlistExisted) {
      await copyFile(
        join(backupDirectory, "s4imsg-launch-agent.plist"),
        input.legacyPaths.launchAgentPath,
      );
      await chmod(input.legacyPaths.launchAgentPath, 0o600);
    }
  };
  let settled = false;
  let safeToRollback = true;
  try {
    if (storedState !== null && state.phase !== "finalizing") {
      safeToRollback = false;
      await dependencies.stopProntoAgent();
      safeToRollback = true;
    }
    if (legacyAgentState !== "stopped") {
      safeToRollback = false;
      await dependencies.stopLegacyAgent();
      safeToRollback = true;
    }
    let changed = false;
    if (state.phase !== "finalizing") {
      await restoreTargets();
      for (const artifact of legacyArtifacts) {
        const backup = join(backupDirectory, basename(artifact.source));
        if (await exists(backup)) {
          if (await sha256File(backup) !== await sha256File(artifact.source)) {
            throw new Error("Legacy state changed after Pronto migration started");
          }
        } else {
          await copyFile(artifact.source, backup);
          await chmod(backup, 0o600);
          changed = true;
        }
        if (await exists(artifact.target)) {
          if (await sha256File(artifact.target) !== await sha256File(backup)) {
            throw new Error("Pronto state conflicts with the legacy migration backup");
          }
        } else {
          await copyFile(backup, artifact.target);
          await chmod(artifact.target, 0o600);
          changed = true;
        }
      }
      state.phase = "prepared";
      await atomicWritePrivate(statePath, `${JSON.stringify(state, null, 2)}\n`);
    }
    return {
      status: changed ? "migrated" : "already_migrated",
      finalize: async () => {
        if (settled) return;
        state.phase = "finalizing";
        await atomicWritePrivate(statePath, `${JSON.stringify(state, null, 2)}\n`);
        await dependencies.installLegacyShim(input.legacyPaths.executablePath);
        if (state.legacyPlistExisted && await exists(input.legacyPaths.launchAgentPath)) {
          await dependencies.removeLegacyAgent(input.legacyPaths.launchAgentPath);
        }
        await atomicWritePrivate(completionMarker, "Pronto migration completed.\n");
        await rm(statePath, { force: true });
        settled = true;
      },
      rollback: async () => {
        if (settled) return;
        await restoreTargets();
        await restoreLegacyFiles();
        await rm(backupDirectory, { force: true, recursive: true });
        if (state.restoreLegacyOnRollback) {
          await dependencies.restoreLegacyAgent(input.legacyPaths.launchAgentPath);
        }
        settled = true;
      },
    };
  } catch (error) {
    if (!safeToRollback) throw error;
    try {
      await restoreTargets();
      await restoreLegacyFiles();
      await rm(backupDirectory, { force: true, recursive: true });
      if (state.restoreLegacyOnRollback) {
        await dependencies.restoreLegacyAgent(input.legacyPaths.launchAgentPath);
      }
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        "Legacy migration failed and the s4imsg listener could not be restored",
      );
    }
    throw error;
  }
}

export type InstalledExecutableRunner = (
  executable: string,
  args: readonly string[],
) => Promise<ProcessResult>;

const INSTALLED_STATUS_POLL_INTERVAL_MS = 250;
const INSTALLED_STATUS_POLL_ATTEMPTS = 40;

export async function qualifyInstalledExecutable(
  executablePath: string,
  runner: InstalledExecutableRunner = runCommand,
  suspendListener: () => Promise<() => Promise<void>> = async () => async () => undefined,
  wait: (milliseconds: number) => Promise<void> = Bun.sleep,
): Promise<void> {
  const restoreListener = await suspendListener();
  let result: ProcessResult;
  try {
    result = await runner(executablePath, ["doctor", "--offline"]);
  } finally {
    await restoreListener();
  }
  if (result.exitCode !== 0) {
    throw new Error(
      `Installed Pronto qualification failed: ${result.stderr.trim() || result.stdout.trim() || result.exitCode}`,
    );
  }
  let status: ProcessResult | undefined;
  for (let attempt = 0; attempt < INSTALLED_STATUS_POLL_ATTEMPTS; attempt += 1) {
    status = await runner(executablePath, ["status"]);
    if (status.exitCode === 0) return;
    if (attempt < INSTALLED_STATUS_POLL_ATTEMPTS - 1) {
      await wait(INSTALLED_STATUS_POLL_INTERVAL_MS);
    }
  }
  throw new Error(
    `Restored Pronto listener qualification failed: ${status?.stderr.trim() || status?.stdout.trim() || status?.exitCode || "unknown status"}`,
  );
}

export async function completeSetupCutover(input: {
  install: () => Promise<void>;
  prepareMigration: () => Promise<LegacyMigration>;
  preflight: () => Promise<void>;
  qualify: () => Promise<void>;
  removeProntoAgent: () => Promise<void>;
  suspendProntoAgent?: () => Promise<() => Promise<void>>;
}): Promise<void> {
  const migration = await input.prepareMigration();
  const restoreProntoAgent = await input.suspendProntoAgent?.() ?? (async () => undefined);
  let installAttempted = false;
  try {
    await input.preflight();
    installAttempted = true;
    await input.install();
    await input.qualify();
  } catch (error) {
    const rollbackErrors: unknown[] = [];
    let prontoStopped = true;
    if (installAttempted) {
      await input.removeProntoAgent().catch((rollbackError) => {
        prontoStopped = false;
        rollbackErrors.push(rollbackError);
      });
    }
    if (prontoStopped) {
      await migration.rollback().catch((rollbackError) => {
        rollbackErrors.push(rollbackError);
      });
      await restoreProntoAgent().catch((rollbackError) => {
        rollbackErrors.push(rollbackError);
      });
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [error, ...rollbackErrors],
        "Pronto setup failed and the previous listener could not be fully restored",
      );
    }
    throw error;
  }
  await migration.finalize();
}

export async function resolveWorkspaceSelection(
  value: string,
  homeDirectory: string,
): Promise<WorkspaceSelection> {
  const trimmed = value.trim();
  const expanded =
    trimmed === "~"
      ? homeDirectory
      : trimmed.startsWith("~/")
        ? join(homeDirectory, trimmed.slice(2))
        : trimmed;
  const absolute = resolve(expanded);
  try {
    const metadata = await stat(absolute);
    if (!metadata.isDirectory()) throw new Error(`Expected a directory: ${absolute}`);
    return { exists: true, path: await realpath(absolute) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return { exists: false, path: absolute };
  }
}

export async function createWorkspaceDirectory(path: string): Promise<string> {
  await mkdir(path, { recursive: true });
  return realpath(path);
}

export interface CommandDiscovery {
  imsgPath: string;
  runtimes: Partial<Record<RuntimeKind, string>>;
}

export type CommandLookup = (command: string) => string | null;

export function discoverCommands(lookup: CommandLookup = (command) => Bun.which(command)): CommandDiscovery {
  const imsgPath = lookup("imsg");
  if (imsgPath === null || !isAbsolute(imsgPath)) {
    throw new Error("imsg was not found on PATH; install it before running setup");
  }

  const codex = lookup("codex");
  const claude = lookup("claude");
  const runtimes: Partial<Record<RuntimeKind, string>> = {};
  if (codex !== null && isAbsolute(codex)) runtimes.codex = codex;
  if (claude !== null && isAbsolute(claude)) runtimes.claude = claude;

  return { imsgPath, runtimes };
}

export function prepareSetupConfig(input: {
  chatKeySalt?: string;
  discovery: CommandDiscovery;
  fallbackRuntime?: RuntimeKind;
  primaryRuntime: RuntimeKind;
  tags: readonly string[];
  workingDirectory: string;
}): ProntoConfig {
  const primaryRuntimePath = input.discovery.runtimes[input.primaryRuntime];
  if (primaryRuntimePath === undefined) {
    const label = input.primaryRuntime === "codex" ? "Codex" : "Claude Code";
    throw new Error(`${label} was not found on PATH`);
  }

  const fallbackRuntimePath =
    input.fallbackRuntime === undefined
      ? undefined
      : input.discovery.runtimes[input.fallbackRuntime];
  if (input.fallbackRuntime !== undefined && fallbackRuntimePath === undefined) {
    const label = input.fallbackRuntime === "codex" ? "Codex" : "Claude Code";
    throw new Error(`${label} was not found on PATH`);
  }

  return createConfig({
    ...(input.fallbackRuntime === undefined
      ? {}
      : { fallbackRuntime: input.fallbackRuntime, fallbackRuntimePath: fallbackRuntimePath! }),
    imsgPath: input.discovery.imsgPath,
    ...(input.chatKeySalt === undefined ? {} : { chatKeySalt: input.chatKeySalt }),
    primaryRuntime: input.primaryRuntime,
    primaryRuntimePath,
    tags: input.tags,
    unrestrictedTrustVersion: UNRESTRICTED_TRUST_VERSION,
    workingDirectory: input.workingDirectory,
  });
}

export interface DoctorCheck {
  id: string;
  status: "ok" | "failed" | "degraded";
  remediation?: string;
}

export interface DoctorReport {
  healthy: boolean;
  checks: DoctorCheck[];
}

export type CommandRunner = (
  executable: string,
  args: readonly string[],
) => Promise<ProcessResult>;

export const runCommand: CommandRunner = async (executable, args) => {
  const child = Bun.spawn([executable, ...args], { stderr: "pipe", stdout: "pipe" });
  const [exitCode, stderr, stdout] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
    new Response(child.stdout).text(),
  ]);
  return { exitCode, stderr, stdout };
};

export async function sha256File(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

export interface SetupDependencies {
  buildExecutable: (outputPath: string) => Promise<void>;
  installAgent: (input: { plist: string; plistPath: string }) => Promise<void>;
  saveConfiguration?: (path: string, config: ProntoConfig) => Promise<void>;
}

export function sourceBuild(repositoryRoot: string): (outputPath: string) => Promise<void> {
  return async (outputPath) => {
    const result = await runCommand(Bun.which("bun") ?? "bun", [
      "build",
      join(repositoryRoot, "packages", "cli", "src", "cli.ts"),
      "--compile",
      "--outfile",
      outputPath,
    ]);
    if (result.exitCode !== 0) {
      throw new Error(`Unable to compile pronto: ${result.stderr.trim() || result.exitCode}`);
    }
    // A stable identity + fixed identifier keeps the Designated Requirement constant
    // across rebuilds, so the Full Disk Access grant survives. Ad-hoc ("-") pins TCC to
    // the code hash instead, which bun's non-reproducible --compile invalidates every run.
    const signingIdentity = process.env.PRONTO_CODESIGN_IDENTITY ?? "-";
    const signature = await runCommand("/usr/bin/codesign", [
      "--force",
      "--sign",
      signingIdentity,
      "--identifier",
      "dev.pronto.cli",
      outputPath,
    ]);
    if (signature.exitCode !== 0) {
      throw new Error(
        `Unable to codesign pronto: ${signature.stderr.trim() || signature.exitCode}`,
      );
    }
  };
}

export function executableBuild(executablePath: string): (outputPath: string) => Promise<void> {
  return async (outputPath) => copyFile(executablePath, outputPath);
}

export async function installSetup(input: {
  config: ProntoConfig;
  dependencies?: SetupDependencies;
  paths: ProntoPaths;
  repositoryRoot?: string;
}): Promise<ProntoConfig> {
  const dependencies: SetupDependencies =
    input.dependencies ??
    ({
      buildExecutable:
        input.repositoryRoot === undefined
          ? executableBuild(process.execPath)
          : sourceBuild(input.repositoryRoot),
      installAgent: installLaunchAgent,
    } satisfies SetupDependencies);
  const binDirectory = join(input.paths.appSupportDirectory, "bin");
  await ensurePrivateDirectory(binDirectory);
  await ensurePrivateDirectory(input.paths.logDirectory);
  const temporaryExecutable = join(binDirectory, `.pronto-${randomUUID()}.tmp`);
  const temporaryCompatibilityExecutable = join(binDirectory, `.s4imsg-${randomUUID()}.tmp`);
  const compatibilityExecutable = join(binDirectory, "s4imsg");

  try {
    await dependencies.buildExecutable(temporaryExecutable);
    await chmod(temporaryExecutable, 0o700);
    await atomicWritePrivate(
      temporaryCompatibilityExecutable,
      renderCompatibilityLauncher(input.paths.executablePath),
    );
    await chmod(temporaryCompatibilityExecutable, 0o700);
    const installedExecutableHash = await sha256File(temporaryExecutable);
    const config = { ...input.config, installedExecutableHash };
    const previousConfig = await readFile(input.paths.configPath, "utf8").catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      },
    );
    await (dependencies.saveConfiguration ?? saveConfig)(input.paths.configPath, config);
    try {
      await rename(temporaryExecutable, input.paths.executablePath);
    } catch (error) {
      try {
        if (previousConfig === null) await unlink(input.paths.configPath);
        else await atomicWritePrivate(input.paths.configPath, previousConfig);
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          "Unable to install the executable or restore the previous configuration",
        );
      }
      throw error;
    }
    await rename(temporaryCompatibilityExecutable, compatibilityExecutable);
    await dependencies.installAgent({
      plist: renderLaunchAgent({
        executablePath: input.paths.executablePath,
        logPath: input.paths.logPath,
        runtimeExecutablePaths: [
          input.config.primaryRuntimePath,
          input.config.fallbackRuntimePath,
        ].filter((path): path is string => path !== undefined),
      }),
      plistPath: input.paths.launchAgentPath,
    });
    return config;
  } finally {
    await unlink(temporaryExecutable).catch(() => undefined);
    await unlink(temporaryCompatibilityExecutable).catch(() => undefined);
  }
}

export async function uninstallInstallation(input: {
  paths: ProntoPaths;
  purge?: boolean;
  removeAgent?: (plistPath: string) => Promise<void>;
}): Promise<void> {
  await (input.removeAgent ?? removeLaunchAgent)(input.paths.launchAgentPath);
  await unlink(input.paths.executablePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
  await unlink(join(dirname(input.paths.executablePath), "s4imsg")).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    },
  );
  if (input.purge === true) {
    await rm(input.paths.appSupportDirectory, { force: true, recursive: true });
    await rm(input.paths.logDirectory, { force: true, recursive: true });
  }
}

async function executableCheck(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function inspectInstallation(
  paths: ProntoPaths,
  runner: CommandRunner = runCommand,
): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  let config: ProntoConfig;
  try {
    config = await loadConfig(paths.configPath);
    checks.push({ id: "configuration", status: "ok" });
  } catch {
    return {
      checks: [
        {
          id: "configuration",
          remediation: "Run pronto setup to create a valid private configuration.",
          status: "failed",
        },
      ],
      healthy: false,
    };
  }

  const executableReady = await executableCheck(paths.executablePath);
  let integrityMatches = false;
  if (executableReady && config.installedExecutableHash !== undefined) {
    integrityMatches = (await sha256File(paths.executablePath)) === config.installedExecutableHash;
  }
  checks.push(
    integrityMatches
      ? { id: "executable-integrity", status: "ok" }
      : {
          id: "executable-integrity",
          remediation: "Re-run pronto setup to reinstall the stable executable and recheck macOS privacy grants.",
          status: "failed",
        },
  );

  for (const [id, executable] of [
    ["imsg-command", config.imsgPath],
    ["primary-runtime", config.primaryRuntimePath],
    ["fallback-runtime", config.fallbackRuntimePath],
  ] as const) {
    if (executable === undefined) continue;
    if (!(await executableCheck(executable))) {
      checks.push({ id, remediation: `Re-run setup after installing ${id}.`, status: "failed" });
      continue;
    }
    const result = await runner(executable, ["--version"]);
    checks.push(
      result.exitCode === 0
        ? { id, status: "ok" }
        : { id, remediation: `Repair or reauthenticate ${id}, then run doctor again.`, status: "failed" },
    );
  }

  return {
    checks,
    healthy: checks.every((check) => check.status !== "failed"),
  };
}
