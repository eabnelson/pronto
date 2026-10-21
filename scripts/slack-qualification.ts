import { readFile, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
export const SLACK_GATES = [
  "signed-helper-arm64",
  "signed-helper-x64",
  "owner-acceptance",
  "setup-and-reply",
] as const;

export interface SlackQualification {
  version: 2;
  releaseTag: string;
  artifacts: Record<string, string>;
  checks: Array<{ id: string; status: "pending" | "pass" | "fail"; evidence: string }>;
}
export function validateSlackQualification(value: SlackQualification, releaseTag: string): void {
  if (value.version !== 2 || value.releaseTag !== releaseTag) throw new Error("Slack qualification must match the current policy and exact release tag");
  for (const architecture of ["arm64", "x64"]) if (!/^[a-f0-9]{64}$/.test(value.artifacts[architecture] ?? "")) throw new Error(`Missing ${architecture} signed artifact hash`);
  const seen = new Set<string>();
  for (const check of value.checks) {
    if (!(SLACK_GATES as readonly string[]).includes(check.id) || seen.has(check.id)) throw new Error("Invalid or duplicate Slack gate"); seen.add(check.id);
    if (check.status !== "pass" || check.evidence.trim().length < 10) throw new Error(`Slack gate pending or failed: ${check.id}`);
  }
  if (SLACK_GATES.some((gate) => !seen.has(gate))) throw new Error("Slack qualification has missing gates");
}
if (import.meta.main) {
  const [action, file, tag] = process.argv.slice(2);
  if (!file || !tag || !["--init", "--check"].includes(action ?? "")) throw new Error("Usage: bun scripts/slack-qualification.ts --init|--check <file> <release-tag>");
  // Qualification records belong to this checkout; resolve parent symlinks before writing.
  const root = await realpath(join(import.meta.dir, ".."));
  const directory = await realpath(dirname(resolve(file)));
  if (directory !== root && !directory.startsWith(root + sep)) throw new Error("Qualification records must be inside this checkout");
  const path = join(directory, basename(file));
  if (action === "--init") {
    await writeFile(path, JSON.stringify({ version: 2, releaseTag: tag, artifacts: {}, checks: SLACK_GATES.map((id) => ({ id, status: "pending", evidence: "" })) }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  } else { validateSlackQualification(JSON.parse(await readFile(path, "utf8")), tag); console.log("All recorded Slack qualification gates pass."); }
}
