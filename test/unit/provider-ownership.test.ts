import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { providerOwnershipViolations } from "../../scripts/provider-ownership";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (path) => {
    await rm(path, { force: true, recursive: true });
  }));
});

async function fixture(files: Readonly<Record<string, string>>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pronto-provider-ownership-"));
  temporaryDirectories.push(root);
  await mkdir(join(root, "packages", "cli", "src", "imessage"), { recursive: true });
  for (const [path, source] of Object.entries(files)) {
    const target = join(root, path);
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, source);
  }
  return root;
}

test("the standalone product cannot recreate provider mechanics outside pronto-imessage", async () => {
  expect(await providerOwnershipViolations(join(import.meta.dir, "../.."))).toEqual([]);
});

test("provider ownership rejects every prohibited implementation category", async () => {
  const legacy = await fixture({
    "packages/cli/src/imessage/message.ts": "export const duplicate = true;",
  });
  expect(await providerOwnershipViolations(legacy)).toContain(
    "packages/cli/src/imessage/message.ts duplicates provider mechanics owned by pronto-imessage",
  );

  const internalImport = await fixture({
    "packages/cli/src/consumer.ts":
      'import "../../../messages/src/internal/rpc.js";\nexport const consumer = true;',
  });
  expect(await providerOwnershipViolations(internalImport)).toContain(
    "packages/cli/src/consumer.ts imports a pronto-imessage implementation detail",
  );

  const subpathImport = await fixture({
    "packages/cli/src/consumer.ts":
      'import "pronto-imessage/internal";\nexport const consumer = true;',
  });
  expect(await providerOwnershipViolations(subpathImport)).toContain(
    "packages/cli/src/consumer.ts imports a pronto-imessage implementation detail",
  );

  const protocol = await fixture({
    "packages/cli/src/consumer.ts": 'export const method = "watch.subscribe";',
  });
  expect(await providerOwnershipViolations(protocol)).toContain(
    "packages/cli/src/consumer.ts contains provider RPC method watch.subscribe",
  );

  const implementation = await fixture({
    "packages/cli/src/imessage/consumer.ts": "export const child = Bun.spawn([]);",
  });
  expect(await providerOwnershipViolations(implementation)).toContain(
    "packages/cli/src/imessage/consumer.ts contains provider implementation token Bun.spawn",
  );
});

test("provider ownership permits the public package seam and unrelated CLI behavior", async () => {
  const root = await fixture({
    "packages/cli/src/imessage/consumer.ts":
      'import type { ProntoMessages } from "pronto-imessage";\nexport type Consumer = ProntoMessages;',
    "packages/cli/src/runtime.ts": "export const status = 'ready';",
  });
  expect(await providerOwnershipViolations(root)).toEqual([]);
});
