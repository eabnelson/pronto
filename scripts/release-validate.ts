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

if (failures.length > 0) {
  for (const failure of failures) console.error(`release validation: ${failure}`);
  process.exit(1);
}

console.log("release validation passed");
