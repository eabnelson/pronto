import { unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { atomicWritePrivate } from "../config";
import { LAUNCH_AGENT_LABEL } from "./paths";

export interface ProcessResult {
  exitCode: number;
  stderr: string;
  stdout: string;
}

export type LaunchctlRunner = (args: readonly string[]) => Promise<ProcessResult>;

const BOOTOUT_POLL_INTERVAL_MS = 100;
const BOOTOUT_POLL_ATTEMPTS = 50;

export type LaunchAgentState = "running" | "loaded" | "stopped";

export function parseLaunchAgentState(result: ProcessResult): LaunchAgentState {
  if (result.exitCode !== 0) return "stopped";
  return /(?:^|\n)\s*state\s*=\s*running\s*(?:\n|$)/.test(result.stdout) &&
    /(?:^|\n)\s*pid\s*=\s*\d+\s*(?:\n|$)/.test(result.stdout)
    ? "running"
    : "loaded";
}

export async function launchAgentStateForLabel(input: {
  label: string;
  runner?: LaunchctlRunner;
  uid?: number;
}): Promise<LaunchAgentState> {
  const runner = input.runner ?? runLaunchctl;
  const uid = input.uid ?? process.getuid?.();
  if (uid === undefined) throw new Error("Unable to determine the current user ID");
  return parseLaunchAgentState(await runner(["print", `gui/${uid}/${input.label}`]));
}

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function renderLaunchAgent(input: {
  executablePath: string;
  logPath: string;
  runtimeExecutablePaths: readonly string[];
}): string {
  const runtimePath = [...new Set([
    ...input.runtimeExecutablePaths.map((path) => dirname(path)),
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ])].join(":");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCH_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(input.executablePath)}</string>
    <string>run</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xml(runtimePath)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${xml(input.logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(input.logPath)}</string>
</dict>
</plist>
`;
}

export const runLaunchctl: LaunchctlRunner = async (args) => {
  const child = Bun.spawn(["/bin/launchctl", ...args], {
    stderr: "pipe",
    stdout: "pipe",
  });
  const [exitCode, stderr, stdout] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
    new Response(child.stdout).text(),
  ]);
  return { exitCode, stderr, stdout };
};

export async function installLaunchAgent(input: {
  plist: string;
  plistPath: string;
  runner?: LaunchctlRunner;
  uid?: number;
  wait?: (milliseconds: number) => Promise<void>;
}): Promise<void> {
  const runner = input.runner ?? runLaunchctl;
  const wait = input.wait ?? Bun.sleep;
  const uid = input.uid ?? process.getuid?.();
  if (uid === undefined) throw new Error("Unable to determine the current user ID");
  const service = `gui/${uid}/${LAUNCH_AGENT_LABEL}`;

  await atomicWritePrivate(input.plistPath, input.plist);
  await stopLaunchAgentForLabel({ label: LAUNCH_AGENT_LABEL, runner, uid, wait });
  const bootstrap = await runner(["bootstrap", `gui/${uid}`, input.plistPath]);
  if (bootstrap.exitCode !== 0) {
    await unlink(input.plistPath).catch(() => undefined);
    throw new Error(`launchctl bootstrap failed: ${bootstrap.stderr.trim() || bootstrap.exitCode}`);
  }
  const kickstart = await runner(["kickstart", "-k", service]);
  if (kickstart.exitCode !== 0) {
    await runner(["bootout", service]);
    await unlink(input.plistPath).catch(() => undefined);
    throw new Error(`launchctl kickstart failed: ${kickstart.stderr.trim() || kickstart.exitCode}`);
  }
}

export async function stopLaunchAgent(
  runner: LaunchctlRunner = runLaunchctl,
  uid = process.getuid?.(),
): Promise<ProcessResult> {
  if (uid === undefined) throw new Error("Unable to determine the current user ID");
  return runner(["bootout", `gui/${uid}/${LAUNCH_AGENT_LABEL}`]);
}

export async function restartLaunchAgent(
  runner: LaunchctlRunner = runLaunchctl,
  uid = process.getuid?.(),
): Promise<ProcessResult> {
  if (uid === undefined) throw new Error("Unable to determine the current user ID");
  return runner(["kickstart", "-k", `gui/${uid}/${LAUNCH_AGENT_LABEL}`]);
}

export async function removeLaunchAgent(
  plistPath: string,
  runner: LaunchctlRunner = runLaunchctl,
  uid = process.getuid?.(),
): Promise<void> {
  await removeLaunchAgentForLabel({
    label: LAUNCH_AGENT_LABEL,
    plistPath,
    runner,
    ...(uid === undefined ? {} : { uid }),
  });
}

export async function removeLaunchAgentForLabel(input: {
  label: string;
  plistPath: string;
  runner?: LaunchctlRunner;
  uid?: number;
  wait?: (milliseconds: number) => Promise<void>;
}): Promise<void> {
  const runner = input.runner ?? runLaunchctl;
  const uid = input.uid ?? process.getuid?.();
  if (uid === undefined) throw new Error("Unable to determine the current user ID");
  await stopLaunchAgentForLabel({
    label: input.label,
    runner,
    uid,
    ...(input.wait === undefined ? {} : { wait: input.wait }),
  });
  await unlink(input.plistPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
}

export async function stopLaunchAgentForLabel(input: {
  label: string;
  runner?: LaunchctlRunner;
  uid?: number;
  wait?: (milliseconds: number) => Promise<void>;
}): Promise<void> {
  const runner = input.runner ?? runLaunchctl;
  const uid = input.uid ?? process.getuid?.();
  const wait = input.wait ?? Bun.sleep;
  if (uid === undefined) throw new Error("Unable to determine the current user ID");
  const service = `gui/${uid}/${input.label}`;

  await runner(["bootout", service]);
  for (let attempt = 0; attempt < BOOTOUT_POLL_ATTEMPTS; attempt += 1) {
    const current = await runner(["print", service]);
    if (current.exitCode !== 0) return;
    if (attempt === BOOTOUT_POLL_ATTEMPTS - 1) {
      throw new Error(
        `${input.label} is still loaded after launchctl bootout; run setup again`,
      );
    }
    await wait(BOOTOUT_POLL_INTERVAL_MS);
  }
}

export async function restoreLaunchAgentForLabel(input: {
  label: string;
  plistPath: string;
  runner?: LaunchctlRunner;
  uid?: number;
}): Promise<void> {
  const runner = input.runner ?? runLaunchctl;
  const uid = input.uid ?? process.getuid?.();
  if (uid === undefined) throw new Error("Unable to determine the current user ID");
  const domain = `gui/${uid}`;
  const service = `${domain}/${input.label}`;
  const bootstrap = await runner(["bootstrap", domain, input.plistPath]);
  if (bootstrap.exitCode !== 0) {
    throw new Error(
      `launchctl could not restore ${input.label}: ${bootstrap.stderr.trim() || bootstrap.exitCode}`,
    );
  }
  const kickstart = await runner(["kickstart", "-k", service]);
  if (kickstart.exitCode !== 0) {
    throw new Error(
      `launchctl could not restart ${input.label}: ${kickstart.stderr.trim() || kickstart.exitCode}`,
    );
  }
}
