import { access, readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";

const REMOVED_PROVIDER_FILES = [
  "packages/cli/src/imessage/message.ts",
  "packages/cli/src/imessage/probe.ts",
  "packages/cli/src/imessage/rpc-client.ts",
] as const;

const PROVIDER_PROTOCOL_LITERALS = [
  "chats.list",
  "messages.after",
  "messages.history",
  "messages.stats",
  "watch.overflow",
  "watch.subscribe",
  "watch.unsubscribe",
] as const;

const IMESSAGE_IMPLEMENTATION_TOKENS = [
  "Bun.spawn",
  "node:child_process",
  "protocol_version",
  "resume_after_rowid",
  "routing_metadata",
] as const;

async function sourceFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(path));
    else if (entry.name.endsWith(".ts")) files.push(path);
  }
  return files;
}

export async function providerOwnershipViolations(root: string): Promise<string[]> {
  const violations: string[] = [];
  for (const path of REMOVED_PROVIDER_FILES) {
    try {
      await access(join(root, path));
      violations.push(`${path} duplicates provider mechanics owned by pronto-imessage`);
    } catch {
      // Expected: the public module owns these implementations.
    }
  }

  const cliRoot = join(root, "packages", "cli", "src");
  for (const path of await sourceFiles(cliRoot)) {
    const source = await readFile(path, "utf8");
    const displayPath = relative(root, path);
    if (source.includes("messages/src/internal") || source.includes("pronto-imessage/")) {
      violations.push(`${displayPath} imports a pronto-imessage implementation detail`);
    }
    for (const method of PROVIDER_PROTOCOL_LITERALS) {
      if (source.includes(`"${method}"`) || source.includes(`'${method}'`)) {
        violations.push(`${displayPath} contains provider RPC method ${method}`);
      }
    }
    if (displayPath.startsWith("packages/cli/src/imessage/")) {
      for (const token of IMESSAGE_IMPLEMENTATION_TOKENS) {
        if (source.includes(token)) {
          violations.push(`${displayPath} contains provider implementation token ${token}`);
        }
      }
    }
  }
  return violations;
}
