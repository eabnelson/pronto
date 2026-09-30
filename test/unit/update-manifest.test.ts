import { afterEach, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MENUBAR_ARCHIVE_NAME, MENUBAR_MANIFEST_NAME, verifyMenubarEnvelope } from "../../packages/cli/src/menubar";
import { verifyProntoUpdateEnvelope } from "../../packages/cli/src/update";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

test("signs the executable and menu bar manifests with the release key", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pronto-manifest-"));
  temporaryDirectories.push(directory);
  for (const name of ["pronto-darwin-arm64", "pronto-darwin-x64", MENUBAR_ARCHIVE_NAME]) {
    await writeFile(join(directory, name), `artifact ${name}`);
  }
  const keys = generateKeyPairSync("ed25519");
  const child = Bun.spawn(["bun", "scripts/generate-update-manifest.ts"], {
    cwd: import.meta.dir.replace(/\/test\/unit$/, ""),
    env: {
      ...Bun.env,
      PRONTO_RELEASE_DIRECTORY: directory,
      PRONTO_RELEASE_ED25519_PRIVATE_KEY: keys.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
      PRONTO_RELEASE_PUBLISHED_AT: "2026-09-29T12:00:00.000Z",
      PRONTO_RELEASE_REVISION: "b".repeat(40),
      PRONTO_RELEASE_VERSION: "0.5.0",
    },
    stderr: "pipe",
  });
  expect(await child.exited).toBe(0);

  const publicKey = keys.publicKey.export({ format: "der", type: "spki" }).toString("base64");
  const now = new Date("2026-09-30T00:00:00.000Z");
  const cli = verifyProntoUpdateEnvelope(await readFile(join(directory, "pronto-update.json")), now, publicKey);
  const menubar = verifyMenubarEnvelope(await readFile(join(directory, MENUBAR_MANIFEST_NAME)), now, publicKey);
  expect(cli.version).toBe("0.5.0");
  expect(menubar).toMatchObject({
    artifact: {
      size: `artifact ${MENUBAR_ARCHIVE_NAME}`.length,
      url: `https://github.com/eabnelson/pronto/releases/download/v0.5.0/${MENUBAR_ARCHIVE_NAME}`,
    },
    sourceRevision: "b".repeat(40),
    version: "0.5.0",
  });
});
