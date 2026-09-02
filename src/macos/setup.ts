import { access, chmod, copyFile, mkdir, readFile, realpath, rename, rm, stat, unlink } from "node:fs/promises";
import { constants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { basename, isAbsolute, join, resolve } from "node:path";
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
  removeLaunchAgent,
  removeLaunchAgentForLabel,
  renderLaunchAgent,
  type ProcessResult,
} from "./launch-agent";
import { LEGACY_LAUNCH_AGENT_LABEL, type ProntoPaths } from "./paths";

export const TRUST_DISCLOSURE = `The trigger tag is not authentication: any participant, current or future, in an eligible iMessage conversation can instruct your selected local agent. Claude Code and Codex will bypass their approval and sandbox prompts and can run commands or change files anywhere this macOS user can access. Adding a participant or eligible chat does not ask for consent again; untagged messages and attachments are untrusted evidence but may still influence the model. A selected folder's project instructions, hooks, and MCP servers may also run with this unrestricted access. Conversation material may be sent to your selected model provider. You are responsible for informing participants.`;

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
  return `Pronto installed.

Finish setup:
1. In System Settings > Privacy & Security > Full Disk Access, add this exact file:
   ${paths.executablePath}
   After an upgrade, remove and re-add a stale pronto entry if macOS no longer recognizes it.
2. Wait for the checks to finish:
   ${executable} doctor
3. Confirm the background listener is ready:
   ${executable} status
4. Send ${tags[0]} ping in an iMessage chat where this Mac owner has already sent a message.

Configured tags: ${tags.join(", ")}
Add or remove tags later with ${executable} tags add <tag> and ${executable} tags remove <tag>.`;
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
    const tags = value.version === 1
      ? typeof value.tag === "string" ? normalizeTags([value.tag]) : null
      : value.version === 2
        ? Array.isArray(value.tags) && value.tags.every((tag) => typeof tag === "string")
          ? normalizeTags(value.tags)
          : null
        : ["@s4"];
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

export async function migrateLegacyInstallation(input: {
  legacyPaths: ProntoPaths;
  paths: ProntoPaths;
  removeLegacyAgent?: (plistPath: string) => Promise<void>;
}): Promise<"not_found" | "already_migrated" | "migrated"> {
  const exists = async (path: string): Promise<boolean> => {
    try {
      await access(path);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  };
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
  if (legacyArtifacts.length === 0 && !legacyAgentExists) return "not_found";

  if (legacyAgentExists) {
    await (input.removeLegacyAgent ?? ((plistPath) => removeLaunchAgentForLabel({
      label: LEGACY_LAUNCH_AGENT_LABEL,
      plistPath,
    })))(input.legacyPaths.launchAgentPath);
  }

  const backupDirectory = join(input.paths.appSupportDirectory, "migration-backup");
  await ensurePrivateDirectory(input.paths.appSupportDirectory);
  await ensurePrivateDirectory(backupDirectory);
  let changed = legacyAgentExists;
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
  return changed ? "migrated" : "already_migrated";
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
      join(repositoryRoot, "src", "cli.ts"),
      "--compile",
      "--outfile",
      outputPath,
    ]);
    if (result.exitCode !== 0) {
      throw new Error(`Unable to compile pronto: ${result.stderr.trim() || result.exitCode}`);
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

  try {
    await dependencies.buildExecutable(temporaryExecutable);
    await chmod(temporaryExecutable, 0o700);
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
    await dependencies.installAgent({
      plist: renderLaunchAgent({
        executablePath: input.paths.executablePath,
        logPath: input.paths.logPath,
      }),
      plistPath: input.paths.launchAgentPath,
    });
    return config;
  } finally {
    await unlink(temporaryExecutable).catch(() => undefined);
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
