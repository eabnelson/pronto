import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, readFile, writeFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { createProntoSlack, createSlackBridge } from "pronto-slack";
import type { ProntoPaths } from "../macos/paths";
import { ensurePrivateDirectory } from "../config";
import { runCommand } from "../macos/setup";
import { PRONTO_SIGNING_TEAM_IDENTIFIER } from "../macos/release-identity";
declare const PRONTO_SLACK_HELPER_BASE64: string | undefined;
declare const PRONTO_SLACK_HELPER_SHA256: string | undefined;
declare const PRONTO_SLACK_HELPER_RELEASE: boolean | undefined;

export const SLACK_DISCLOSURE = `Slack support reuses your direct-download Slack desktop sign-in through an unofficial protocol. Slack may change it or restrict automated accounts. Replies come from your account. Any human participant, current or future, in a selected conversation where you have participated can use your tags to run your local agent with unrestricted access to this Mac. Tags are not authentication. Conversation text may be sent to your model provider. Select only conversations whose participants you trust. Connecting selects no conversations and sends no messages.`;

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
export async function standaloneSlack(input: { paths: Pick<ProntoPaths, "appSupportDirectory">; chatKeySalt: string }) {
  return createProntoSlack({ directory: join(input.paths.appSupportDirectory, "slack"), referenceKey: input.chatKeySalt, bridge: createSlackBridge(await slackHelperPath(input.paths)) });
}
