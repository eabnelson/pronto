import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import packageJson from "../package.json" with { type: "json" };
import messagesPackageJson from "../packages/messages/package.json" with { type: "json" };
import { providerOwnershipViolations } from "./provider-ownership";
import { releaseWorkflowViolations } from "./release-workflow-validation";
import { mutableActionReferences } from "./workflow-validation";

const root = join(import.meta.dir, "..");

async function read(path: string): Promise<string> {
  return Bun.file(join(root, path)).text();
}

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(join(root, directory), { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    if (entry.name === "node_modules") continue;
    const relative = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceFiles(relative)));
    else files.push(relative);
  }

  return files;
}

const failures: string[] = [];
const workflowPaths = [
  ".github/workflows/ci.yml",
  ".github/workflows/pages.yml",
  ".github/workflows/release.yml",
];

if (packageJson.name !== "pronto-workspace") failures.push("root package must be pronto-workspace");
if (packageJson.license !== "MIT") failures.push("package license must be MIT");
if (packageJson.homepage !== "https://github.com/eabnelson/pronto#readme") {
  failures.push("package homepage must point to the public repository");
}
if (packageJson.repository?.url !== "git+https://github.com/eabnelson/pronto.git") {
  failures.push("package repository metadata is missing");
}
if (packageJson.private !== true) failures.push("root workspace must be private");
if (!packageJson.workspaces.includes("packages/*")) {
  failures.push("root package must include the packages workspace");
}
if (messagesPackageJson.name !== "pronto-imessage") {
  failures.push("Messages package must be named pronto-imessage");
}
if (messagesPackageJson.license !== "MIT") {
  failures.push("Messages package license must be MIT");
}
if ("private" in messagesPackageJson && messagesPackageJson.private === true) {
  failures.push("Messages package must be publishable");
}
if (messagesPackageJson.repository?.directory !== "packages/messages") {
  failures.push("Messages package repository directory is missing");
}
if (Object.keys(messagesPackageJson.exports).join(",") !== ".") {
  failures.push("Messages package root must not export internal RPC subpaths");
}

const [license, notices, provenance] = await Promise.all([
  read("LICENSE"),
  read("THIRD_PARTY_NOTICES.md"),
  read("PROVENANCE.md"),
]);

const requiredFiles = [
  "README.md",
  "SECURITY.md",
  "docs/LIVE_SMOKE.md",
  "docs/RELEASE_QUALIFICATION.md",
  ".github/dependabot.yml",
  ".github/ISSUE_TEMPLATE/bug_report.yml",
  ".github/ISSUE_TEMPLATE/feature_request.yml",
  ".github/ISSUE_TEMPLATE/config.yml",
  ".github/PULL_REQUEST_TEMPLATE.md",
  ...workflowPaths,
  "dist/pronto",
  "dist/s4imsg",
  "packages/messages/dist/index.js",
  "packages/messages/dist/index.d.ts",
];
const requiredFileChecks = await Promise.all(
  requiredFiles.map(async (path) => ({
    path,
    exists: await Bun.file(join(root, path)).exists(),
  })),
);
for (const required of requiredFileChecks) {
  if (!required.exists) failures.push(`${required.path} is missing`);
}
for (const [path, args] of [
  ["dist/pronto", ["--version"]],
  ["dist/pronto", ["--help"]],
  ["dist/s4imsg", ["--version"]],
] as const) {
  if (!(await Bun.file(join(root, path)).exists())) continue;
  const command = Bun.spawn([join(root, path), ...args], {
    stderr: "pipe",
    stdout: "pipe",
  });
  if (await command.exited !== 0) {
    failures.push(`${path} ${args.join(" ")} failed after compilation`);
  }
}
failures.push(...await providerOwnershipViolations(root));

if (!license.startsWith("MIT License")) failures.push("MIT license text is missing");
if (!notices.includes("Copyright (c) 2026 Peter Steinberger")) {
  failures.push("imsg copyright notice is missing");
}
if (!provenance.includes("implemented clean-room")) {
  failures.push("clean-room provenance declaration is missing");
}

for (const file of await sourceFiles("packages")) {
  if ((await read(file)).includes("@studio-four/")) {
    failures.push(`${file} imports a Studio Four package`);
  }
}
for (const file of await sourceFiles("packages/messages/src")) {
  const source = await read(file);
  if (/\bBun\b/.test(source)) failures.push(`${file} uses a Bun global`);
}

for (const workflow of await sourceFiles(".github/workflows")) {
  for (const action of mutableActionReferences(await read(workflow))) {
    failures.push(`${workflow} uses a mutable action reference: ${action}`);
  }
}

const [codexAdapter, claudeAdapter, qualification] = await Promise.all([
  read("packages/cli/src/runtimes/codex.ts"),
  read("packages/cli/src/runtimes/claude.ts"),
  read("packages/cli/src/runtimes/qualification.ts"),
]);
const releaseWorkflow = await read(".github/workflows/release.yml");
failures.push(...releaseWorkflowViolations(releaseWorkflow));
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

const packageConsumer = await mkdtemp(join(tmpdir(), "pronto-package-consumer-"));
try {
  const packageBuild = Bun.spawn(
    ["npm", "pack", "--json", "--pack-destination", packageConsumer],
    { cwd: join(root, "packages", "messages"), stderr: "pipe", stdout: "pipe" },
  );
  const [packageExitCode, packageOutput, packageError] = await Promise.all([
    packageBuild.exited,
    new Response(packageBuild.stdout).text(),
    new Response(packageBuild.stderr).text(),
  ]);
  if (packageExitCode !== 0) {
    failures.push(`pronto-imessage is not packable: ${packageError}`);
  } else {
    const packResult = JSON.parse(packageOutput) as Array<{
      filename: string;
      files: Array<{ path: string }>;
    }>;
    const packed = packResult[0];
    if (packed === undefined) {
      failures.push("npm pack did not report a pronto-imessage artifact");
    } else {
      if (packed.files.some((file) => /(?:^|\/)\.git(?:\/|$)/.test(file.path))) {
        failures.push("pronto-imessage package contains Git history");
      }
      const packageFiles = await sourceFiles("packages/messages");
      for (const file of packageFiles) {
        if (/studio[- _]?four|@studio-four\//i.test(await read(file))) {
          failures.push(`${file} contains a private Studio Four identifier`);
        }
      }
      await writeFile(join(packageConsumer, "package.json"), JSON.stringify({
        dependencies: { "pronto-imessage": `file:./${packed.filename}` },
        private: true,
        type: "module",
      }));
      const install = Bun.spawn(
        ["npm", "install", "--ignore-scripts", "--no-audit", "--no-fund", "--offline"],
        { cwd: packageConsumer, stderr: "pipe", stdout: "pipe" },
      );
      if (await install.exited !== 0) {
        failures.push(
          `clean consumer could not install pronto-imessage: ${await new Response(install.stderr).text()}`,
        );
      } else {
        for (const runtime of ["node", "bun"]) {
          const packageImport = Bun.spawn(
            [
              runtime,
              "--input-type=module",
              "--eval",
              'import("pronto-imessage").then((module) => { if (typeof module.createProntoMessages !== "function") process.exit(1); })',
            ],
            { cwd: packageConsumer, stderr: "pipe", stdout: "pipe" },
          );
          if (await packageImport.exited !== 0) {
            failures.push(
              `${runtime} could not import packed pronto-imessage: ${await new Response(packageImport.stderr).text()}`,
            );
          }
        }
      }
    }
  }
} finally {
  await rm(packageConsumer, { force: true, recursive: true });
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`release validation: ${failure}`);
  process.exit(1);
}

console.log("release validation passed");
