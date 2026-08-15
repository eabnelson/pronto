import { afterEach, expect, test } from "bun:test";
import { access, lstat, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openS4imsgDatabase } from "../../src/storage/database";
import { Database } from "bun:sqlite";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

test("retains one private recovery backup when a migration fails", async () => {
  const directory = await mkdtemp(join(tmpdir(), "s4imsg-migration-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "state.sqlite");
  const legacy = new Database(path, { create: true });
  legacy.exec("CREATE TABLE legacy_marker (value TEXT)");
  legacy.close();

  expect(() =>
    openS4imsgDatabase(path, {
      migrate: () => {
        throw new Error("synthetic migration failure");
      },
    }),
  ).toThrow("synthetic migration failure");

  await access(`${path}.backup`);
  expect((await lstat(`${path}.backup`)).mode & 0o777).toBe(0o600);
  const recovery = new Database(`${path}.backup`, { readonly: true });
  try {
    expect(
      recovery
        .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'legacy_marker'")
        .get(),
    ).toEqual({ name: "legacy_marker" });
  } finally {
    recovery.close();
  }
});

test("creates the current owner-private WAL schema", async () => {
  const directory = await mkdtemp(join(tmpdir(), "s4imsg-migration-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "state.sqlite");
  const database = openS4imsgDatabase(path);
  try {
    expect(database.query("PRAGMA user_version").get()).toEqual({ user_version: 1 });
    expect(database.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
  } finally {
    database.close();
  }
});
