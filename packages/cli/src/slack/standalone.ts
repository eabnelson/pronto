import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, readFile, writeFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { createProntoSlack, createSlackBridge } from "pronto-slack";
import type { ProntoPaths } from "../macos/paths";
import { ensurePrivateDirectory } from "../config";
import { runCommand } from "../macos/setup";
import { PRONTO_SIGNING_TEAM_IDENTIFIER } from "../macos/release-identity";
import { isSlackChannel, type SlackChannelKind } from "../channels/types";
declare const PRONTO_SLACK_HELPER_BASE64: string | undefined;
declare const PRONTO_SLACK_HELPER_SHA256: string | undefined;
declare const PRONTO_SLACK_HELPER_RELEASE: boolean | undefined;

export const SLACK_DISCLOSURE = `Slack uses your sign-in in the Slack desktop app and replies as you. Workspace tags work in supported conversations where you have participated. Anyone in those conversations can use the tags to run your local agent with access to this Mac; conversation text may be sent to your model provider. Only add workspaces and use conversations whose participants you trust. Slack support uses an unofficial protocol that Slack may change. Connecting sends no messages.`;

export async function slackHelperPath(paths: Pick<ProntoPaths, "appSupportDirectory">): Promise<string> {
  if (process.platform !== "darwin") throw new Error("slack-macos-required");
  let executable: string;
  const embedded = typeof PRONTO_SLACK_HELPER_BASE64 === "string";
  if (embedded) {
    const bytes = Buffer.from(PRONTO_SLACK_HELPER_BASE64!, "base64");
    const expected = PRONTO_SLACK_HELPER_SHA256!;
    if (createHash("sha256").update(bytes).digest("hex") !== expected) throw new Error("slack-helper-integrity");
    const directory = join(paths.appSupportDirectory, "slack/helpers", expected);
    await ensurePrivateDirectory(directory); executable = join(directory, "slack-helper");
    const stat = await lstat(executable).catch(() => null);
    if (stat !== null && (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.())) throw new Error("slack-helper-integrity");
    if (stat === null) {
      const temporary = `${executable}.${randomUUID()}.tmp`;
      try { await writeFile(temporary, bytes, { flag: "wx", mode: 0o700 }); await rename(temporary, executable); }
      finally { await rm(temporary, { force: true }); }
    }
    if (createHash("sha256").update(await readFile(executable)).digest("hex") !== expected) throw new Error("slack-helper-integrity");
    await chmod(executable, 0o700);
  } else {
    executable = join(import.meta.dir, "../../../slack/native/dist", process.arch === "x64" ? "amd64" : "arm64", "slack-helper");
  }
  const release = typeof PRONTO_SLACK_HELPER_RELEASE === "boolean" && PRONTO_SLACK_HELPER_RELEASE;
  const requirement = `identifier "dev.pronto.slack-helper"${release ? ` and anchor apple generic and certificate leaf[subject.OU] = "${PRONTO_SIGNING_TEAM_IDENTIFIER}"` : ""}`;
  const signature = await runCommand("/usr/bin/codesign", ["--verify", "--strict", `-R=${requirement}`, executable]);
  if (signature.exitCode !== 0) throw new Error("slack-helper-unverified-run-bun-build");
  const selfTest = await runCommand(executable, ["--self-test"]);
  let info: any;
  try { info = JSON.parse(selfTest.stdout); } catch { throw new Error("slack-helper-protocol"); }
  if (selfTest.exitCode !== 0 || info.protocol !== 1 || info.version !== "1" || info.architecture !== (process.arch === "x64" ? "amd64" : process.arch)) throw new Error("slack-helper-protocol");
  return executable;
}
export function slackProviderDirectory(paths: Pick<ProntoPaths, "appSupportDirectory">, workspace: SlackChannelKind = "slack"): string {
  if (!isSlackChannel(workspace)) throw new Error("slack-workspace-invalid");
  return workspace === "slack" ? join(paths.appSupportDirectory, "slack") : join(paths.appSupportDirectory, "slack/workspaces", workspace.slice(6));
}
export async function standaloneSlack(input: { paths: Pick<ProntoPaths, "appSupportDirectory">; chatKeySalt: string; workspace?: SlackChannelKind }) {
  return createProntoSlack({ directory: slackProviderDirectory(input.paths, input.workspace), referenceKey: input.chatKeySalt, bridge: createSlackBridge(await slackHelperPath(input.paths)) });
}
