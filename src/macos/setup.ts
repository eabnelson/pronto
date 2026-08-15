import { access, chmod, readFile, rename, rm, unlink } from "node:fs/promises";
import { constants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, join } from "node:path";
import {
  createConfig,
  ensurePrivateDirectory,
  loadConfig,
  saveConfig,
  type RuntimeKind,
  type S4imsgConfig,
} from "../config";
import {
  installLaunchAgent,
  removeLaunchAgent,
  renderLaunchAgent,
  type ProcessResult,
} from "./launch-agent";
import type { S4imsgPaths } from "./paths";

export const TRUST_DISCLOSURE = `The trigger tag is not authentication: any participant in an eligible iMessage conversation can instruct your selected local agent with its effective noninteractive permissions; untagged messages and attachments are untrusted evidence but may still influence the model. Conversation material may be sent to your selected model provider. You are responsible for informing participants.`;

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
  discovery: CommandDiscovery;
  fallbackRuntime?: RuntimeKind;
  primaryRuntime: RuntimeKind;
  tag: string;
  workingDirectory: string;
}): S4imsgConfig {
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
    primaryRuntime: input.primaryRuntime,
    primaryRuntimePath,
    tag: input.tag,
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
      throw new Error(`Unable to compile s4imsg: ${result.stderr.trim() || result.exitCode}`);
    }
  };
}

export async function installSetup(input: {
  config: S4imsgConfig;
  dependencies?: SetupDependencies;
  paths: S4imsgPaths;
  repositoryRoot?: string;
}): Promise<S4imsgConfig> {
  const dependencies =
    input.dependencies ??
    ({
      buildExecutable: sourceBuild(input.repositoryRoot ?? process.cwd()),
      installAgent: installLaunchAgent,
    } satisfies SetupDependencies);
  const binDirectory = join(input.paths.appSupportDirectory, "bin");
  await ensurePrivateDirectory(binDirectory);
  await ensurePrivateDirectory(input.paths.logDirectory);
  const temporaryExecutable = join(binDirectory, `.s4imsg-${randomUUID()}.tmp`);

  try {
    await dependencies.buildExecutable(temporaryExecutable);
    await chmod(temporaryExecutable, 0o700);
    const installedExecutableHash = await sha256File(temporaryExecutable);
    await rename(temporaryExecutable, input.paths.executablePath);
    const config = { ...input.config, installedExecutableHash };
    await saveConfig(input.paths.configPath, config);
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
  paths: S4imsgPaths;
  purge?: boolean;
  removeAgent?: (plistPath: string) => Promise<void>;
}): Promise<void> {
  await (input.removeAgent ?? removeLaunchAgent)(input.paths.launchAgentPath);
  await unlink(input.paths.executablePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
  if (input.purge === true) {
    await rm(input.paths.appSupportDirectory, { force: true, recursive: true });
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
  paths: S4imsgPaths,
  runner: CommandRunner = runCommand,
): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  let config: S4imsgConfig;
  try {
    config = await loadConfig(paths.configPath);
    checks.push({ id: "configuration", status: "ok" });
  } catch {
    return {
      checks: [
        {
          id: "configuration",
          remediation: "Run s4imsg setup to create a valid private configuration.",
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
          remediation: "Re-run s4imsg setup to reinstall the stable executable and recheck macOS privacy grants.",
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
