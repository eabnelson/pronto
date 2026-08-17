import { readdir } from "node:fs/promises";
import { join } from "node:path";
import packageJson from "../package.json" with { type: "json" };

const root = join(import.meta.dir, "..");

async function read(path: string): Promise<string> {
  return Bun.file(join(root, path)).text();
}

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(join(root, directory), { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const relative = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceFiles(relative)));
    else files.push(relative);
  }

  return files;
}

const failures: string[] = [];

if (packageJson.name !== "s4imsg") failures.push("package name must be s4imsg");
if (packageJson.license !== "MIT") failures.push("package license must be MIT");
if ("private" in packageJson && packageJson.private === true) {
  failures.push("package must not be marked private");
}

const [license, notices, provenance] = await Promise.all([
  read("LICENSE"),
  read("THIRD_PARTY_NOTICES.md"),
  read("PROVENANCE.md"),
]);

for (const required of [
  "README.md",
  "SECURITY.md",
  "docs/LIVE_SMOKE.md",
  "docs/RELEASE_QUALIFICATION.md",
  ".github/dependabot.yml",
  ".github/workflows/ci.yml",
  ".github/workflows/release.yml",
]) {
  if (!(await Bun.file(join(root, required)).exists())) failures.push(`${required} is missing`);
}

if (!license.startsWith("MIT License")) failures.push("MIT license text is missing");
if (!notices.includes("Copyright (c) 2026 Peter Steinberger")) {
  failures.push("imsg copyright notice is missing");
}
if (!provenance.includes("implemented clean-room")) {
  failures.push("clean-room provenance declaration is missing");
}

for (const file of await sourceFiles("src")) {
  if ((await read(file)).includes("@studio-four/")) {
    failures.push(`${file} imports a Studio Four package`);
  }
}

for (const workflow of [".github/workflows/ci.yml", ".github/workflows/release.yml"]) {
  for (const line of (await read(workflow)).split("\n")) {
    const action = line.match(/^\s*-\s+uses:\s+([^\s#]+)/)?.[1];
    if (action !== undefined && !action.startsWith("./") && !/@[0-9a-f]{40}$/.test(action)) {
      failures.push(`${workflow} uses a mutable action reference: ${action}`);
    }
  }
}

const [codexAdapter, claudeAdapter, qualification] = await Promise.all([
  read("src/runtimes/codex.ts"),
  read("src/runtimes/claude.ts"),
  read("src/runtimes/qualification.ts"),
]);
for (const [name, source] of [
  ["Codex", codexAdapter],
  ["Claude Code", claudeAdapter],
] as const) {
  for (const forbidden of ["--model", "--sandbox", "bypassPermissions", "--permission-mode"]) {
    if (source.includes(forbidden)) failures.push(`${name} adapter overrides ${forbidden}`);
  }
}
if (!codexAdapter.includes("--dangerously-bypass-approvals-and-sandbox")) {
  failures.push("Codex adapter must use unrestricted no-prompt mode");
}
if (!claudeAdapter.includes("--dangerously-skip-permissions")) {
  failures.push("Claude Code adapter must use unrestricted no-prompt mode");
}
if (!qualification.includes('"--dangerously-bypass-approvals-and-sandbox"')) {
  failures.push("Codex qualification must require unrestricted no-prompt mode");
}
if (!qualification.includes('"--dangerously-skip-permissions"')) {
  failures.push("Claude Code qualification must require unrestricted no-prompt mode");
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`release validation: ${failure}`);
  process.exit(1);
}

console.log("release validation passed");
