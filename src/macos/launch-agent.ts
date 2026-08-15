import { unlink } from "node:fs/promises";
import { atomicWritePrivate } from "../config";
import { LAUNCH_AGENT_LABEL } from "./paths";

export interface ProcessResult {
  exitCode: number;
  stderr: string;
  stdout: string;
}

export type LaunchctlRunner = (args: readonly string[]) => Promise<ProcessResult>;

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
}): string {
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
}): Promise<void> {
  const runner = input.runner ?? runLaunchctl;
  const uid = input.uid ?? process.getuid?.();
  if (uid === undefined) throw new Error("Unable to determine the current user ID");
  const service = `gui/${uid}/${LAUNCH_AGENT_LABEL}`;

  await atomicWritePrivate(input.plistPath, input.plist);
  await runner(["bootout", service]);
  const bootstrap = await runner(["bootstrap", `gui/${uid}`, input.plistPath]);
  if (bootstrap.exitCode !== 0) {
    throw new Error(`launchctl bootstrap failed: ${bootstrap.stderr.trim() || bootstrap.exitCode}`);
  }
  const kickstart = await runner(["kickstart", "-k", service]);
  if (kickstart.exitCode !== 0) {
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

export async function removeLaunchAgent(
  plistPath: string,
  runner: LaunchctlRunner = runLaunchctl,
  uid = process.getuid?.(),
): Promise<void> {
  await stopLaunchAgent(runner, uid);
  await unlink(plistPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
}
