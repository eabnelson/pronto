import { readFile, writeFile } from "node:fs/promises";
export const SLACK_GATES = ["signed-helper-arm64", "signed-helper-x64", "fresh-keychain-approval", "background-without-prompts", "desktop-open-closed-updated", "identity-change-and-revocation", "self-dm-end-to-end", "dm-group-public-private", "five-conversations-30-minutes", "unseen-old-threads-and-read-elsewhere", "hard-restart-and-ambiguous-send", "native-wake-two-hour-sleep", "menu-bar-and-cli-parity", "update-and-rollback"] as const;
export interface SlackQualification { version: 1; releaseTag: string; artifacts: Record<string, string>; checks: Array<{ id: string; status: "pending" | "pass" | "fail"; evidence: string }>; monitoring?: { durationMs: number; conversations: number; samples: number; missed: number; p95Ms: number; clockSkewMs: number }; sleep?: { durationMs: number; nativeWake: boolean; independentlyPublishedDuringSleep: boolean } }
export function validateSlackQualification(value: SlackQualification, releaseTag: string): void {
  if (value.version !== 1 || value.releaseTag !== releaseTag) throw new Error("Slack qualification must match the exact release candidate");
  for (const architecture of ["arm64", "x64"]) if (!/^[a-f0-9]{64}$/.test(value.artifacts[architecture] ?? "")) throw new Error(`Missing ${architecture} signed artifact hash`);
  const seen = new Set<string>();
  for (const check of value.checks) {
    if (!(SLACK_GATES as readonly string[]).includes(check.id) || seen.has(check.id)) throw new Error("Invalid or duplicate Slack gate"); seen.add(check.id);
    if (check.status !== "pass" || check.evidence.trim().length < 10) throw new Error(`Slack gate pending or failed: ${check.id}`);
  }
  if (SLACK_GATES.some((gate) => !seen.has(gate))) throw new Error("Slack qualification has missing gates");
  const monitor = value.monitoring;
  if (!monitor || ![monitor.durationMs, monitor.conversations, monitor.samples, monitor.missed, monitor.p95Ms, monitor.clockSkewMs].every((number) => typeof number === "number" && Number.isFinite(number)) || monitor.p95Ms < 0 || monitor.durationMs < 1_800_000 || monitor.conversations !== 5 || monitor.samples < 20 || monitor.missed !== 0 || monitor.p95Ms >= 10_000 || Math.abs(monitor.clockSkewMs) > 1_000) throw new Error("Slack monitoring performance gate has not passed");
  if (!value.sleep || typeof value.sleep.durationMs !== "number" || !Number.isFinite(value.sleep.durationMs) || value.sleep.durationMs < 7_200_000 || !value.sleep.nativeWake || !value.sleep.independentlyPublishedDuringSleep) throw new Error("Slack long-sleep gate has not passed");
}
if (import.meta.main) {
  const [action, file, tag] = process.argv.slice(2);
  if (!file || !tag || !["--init", "--check"].includes(action ?? "")) throw new Error("Usage: bun scripts/slack-qualification.ts --init|--check <file> <release-tag>");
  if (action === "--init") {
    await writeFile(file, JSON.stringify({ version: 1, releaseTag: tag, artifacts: {}, checks: SLACK_GATES.map((id) => ({ id, status: "pending", evidence: "" })) }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  } else { validateSlackQualification(JSON.parse(await readFile(file, "utf8")), tag); console.log("All recorded Slack qualification gates pass."); }
}
