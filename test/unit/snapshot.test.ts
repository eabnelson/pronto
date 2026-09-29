import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { restoreNewerDatabase, snapshotDatabase } from "../../packages/cli/src/storage/snapshot";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

async function fixture(version: number) {
  const directory = await mkdtemp(join(tmpdir(), "pronto-snapshot-"));
  temporaryDirectories.push(directory);
  const databasePath = join(directory, "state.sqlite");
  const database = new Database(databasePath, { create: true, strict: true });
  database.exec("PRAGMA journal_mode = WAL");
  database.exec("CREATE TABLE notes (value TEXT)");
  database.exec("INSERT INTO notes VALUES ('before update')");
  database.exec(`PRAGMA user_version = ${version}`);
  database.close();
  return { databasePath, snapshotPath: join(directory, "snapshot.sqlite") };
}

function inspect(path: string): { notes: string[]; version: number } {
  const database = new Database(path, { readonly: true, strict: true });
  try {
    return {
      notes: (database.query("SELECT value FROM notes").all() as Array<{ value: string }>)
        .map((row) => row.value),
      version: (database.query("PRAGMA user_version").get() as { user_version: number }).user_version,
    };
  } finally {
    database.close();
  }
}

function migrate(path: string, version: number): void {
  const database = new Database(path, { strict: true });
  database.exec("INSERT INTO notes VALUES ('written by candidate')");
  database.exec(`PRAGMA user_version = ${version}`);
  database.close();
}

test("restores the pre-update database when the candidate migrated past the supported schema", async () => {
  const { databasePath, snapshotPath } = await fixture(5);
  expect(snapshotDatabase(databasePath, snapshotPath)).toBeTrue();
  migrate(databasePath, 6);

  expect(restoreNewerDatabase(databasePath, snapshotPath, 5)).toBeTrue();
  expect(inspect(databasePath)).toEqual({ notes: ["before update"], version: 5 });
  expect(existsSync(`${databasePath}-wal`)).toBeFalse();
  expect(existsSync(snapshotPath)).toBeFalse();
});

test("keeps state written by the candidate when the schema is still readable", async () => {
  const { databasePath, snapshotPath } = await fixture(5);
  snapshotDatabase(databasePath, snapshotPath);
  migrate(databasePath, 5);

  expect(restoreNewerDatabase(databasePath, snapshotPath, 5)).toBeFalse();
  expect(inspect(databasePath).notes).toEqual(["before update", "written by candidate"]);
});

test("does nothing before the first database exists", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pronto-snapshot-"));
  temporaryDirectories.push(directory);
  const databasePath = join(directory, "state.sqlite");
  const snapshotPath = join(directory, "snapshot.sqlite");
  expect(snapshotDatabase(databasePath, snapshotPath)).toBeFalse();
  expect(restoreNewerDatabase(databasePath, snapshotPath, 5)).toBeFalse();
});
