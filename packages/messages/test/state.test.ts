import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ProviderStateStore } from "../src/internal/state";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

async function statePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pronto-provider-state-"));
  temporaryDirectories.push(directory);
  return join(directory, "provider-state.json");
}

test("migrates and backs up a legacy unscoped cursor without assigning a generation", async () => {
  const path = await statePath();
  const legacy = `${JSON.stringify({ cursor: 91, version: 1 })}\n`;
  await writeFile(path, legacy, { mode: 0o600 });
  const store = new ProviderStateStore(path);

  expect(await store.checkpoint("generation-one")).toBeUndefined();
  expect(await readFile(`${path}.v1.backup`, "utf8")).toBe(legacy);
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
    checkpoint: null,
    legacyUnscopedCursor: 91,
    version: 2,
  });
  expect((await stat(path)).mode & 0o777).toBe(0o600);
});

test("rejects unknown newer provider state without mutating or backing it up", async () => {
  const path = await statePath();
  const future = `${JSON.stringify({ checkpoint: null, version: 3 })}\n`;
  await writeFile(path, future, { mode: 0o600 });

  await expect(new ProviderStateStore(path).checkpoint("generation-one"))
    .rejects.toThrow("provider_state_version_unsupported");
  expect(await readFile(path, "utf8")).toBe(future);
  expect(await Bun.file(`${path}.v1.backup`).exists()).toBeFalse();
});

test("quarantines a standalone legacy cursor when provider state is first created", async () => {
  const path = await statePath();
  const store = new ProviderStateStore(path, { legacyUnscopedCursor: 73 });
  expect(await store.checkpoint("generation-one")).toBeUndefined();
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
    checkpoint: null,
    legacyUnscopedCursor: 73,
    version: 2,
  });
});

test("advances only within one proven generation and never reuses a replaced generation", async () => {
  const path = await statePath();
  const store = new ProviderStateStore(path);

  await store.advance("generation-one", 40);
  await store.advance("generation-one", 30);
  expect(await store.checkpoint("generation-one")).toEqual({
    databaseGeneration: "generation-one",
    rowId: 40,
    version: 1,
  });
  expect(await store.checkpoint("generation-two")).toBeUndefined();
  await store.advance("generation-two", 7);
  expect(await store.checkpoint("generation-two")).toMatchObject({ rowId: 7 });
  expect(await store.checkpoint("generation-one")).toBeUndefined();
});

test("retains a bounded set of recent checkpoint witnesses", async () => {
  const path = await statePath();
  const store = new ProviderStateStore(path);

  for (let rowId = 1; rowId <= 6; rowId += 1) {
    await store.advance("generation-one", rowId, {
      providerMessageDigest: `digest-${rowId}`,
      rowId,
    });
  }

  expect((await store.checkpoint("generation-one"))?.witnesses).toEqual([
    { providerMessageDigest: "digest-3", rowId: 3 },
    { providerMessageDigest: "digest-4", rowId: 4 },
    { providerMessageDigest: "digest-5", rowId: 5 },
    { providerMessageDigest: "digest-6", rowId: 6 },
  ]);
});
