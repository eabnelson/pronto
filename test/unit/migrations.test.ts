import { afterEach, expect, test } from "bun:test";
import { access, lstat, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openS4imsgDatabase } from "../../src/storage/database";
import { CURRENT_SCHEMA_VERSION } from "../../src/storage/migrations";
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
    expect(database.query("PRAGMA user_version").get()).toEqual({
      user_version: CURRENT_SCHEMA_VERSION,
    });
    expect(database.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
    expect(
      database
        .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'chat_workspaces'")
        .get(),
    ).toEqual({ name: "chat_workspaces" });
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
  } finally {
    database.close();
  }
});

test("upgrades a version-two database without changing existing delivery rows", async () => {
  const directory = await mkdtemp(join(tmpdir(), "s4imsg-migration-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "state.sqlite");
  const legacy = new Database(path, { create: true });
  legacy.exec(`
    CREATE TABLE delivery_events (
      provider_guid TEXT PRIMARY KEY,
      chat_key TEXT NOT NULL,
      chat_id INTEGER NOT NULL,
      tagged_request TEXT,
      state TEXT NOT NULL,
      lease_token TEXT,
      tool_activity INTEGER,
      resume_count INTEGER NOT NULL DEFAULT 0,
      accepted_reply TEXT,
      proposed_summary TEXT,
      compaction_due INTEGER NOT NULL DEFAULT 0,
      outbound_guid TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      memory_eligible INTEGER NOT NULL DEFAULT 1,
      outbound_fingerprint TEXT,
      outbound_fingerprint_expires_at INTEGER
    );
    INSERT INTO delivery_events
      (provider_guid, chat_key, chat_id, state, created_at, updated_at)
      VALUES ('existing', 'chat-a', 42, 'delivered', 1, 1);
    PRAGMA user_version = 2;
  `);
  legacy.close();

  const database = openS4imsgDatabase(path);
  try {
    expect(database.query("PRAGMA user_version").get()).toEqual({
      user_version: CURRENT_SCHEMA_VERSION,
    });
    expect(
      database
        .query("SELECT provider_guid, state FROM delivery_events WHERE provider_guid = 'existing'")
        .get(),
    ).toEqual({ provider_guid: "existing", state: "delivered" });
    expect(
      database
        .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'chat_workspaces'")
        .get(),
    ).toEqual({ name: "chat_workspaces" });
  } finally {
    database.close();
  }
});

test("removes a recovery backup after a successful migration", async () => {
  const directory = await mkdtemp(join(tmpdir(), "s4imsg-migration-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "state.sqlite");
  const empty = new Database(path, { create: true });
  empty.exec("CREATE TABLE pre_migration_marker (value TEXT)");
  empty.close();

  const database = openS4imsgDatabase(path);
  database.close();
  await expect(access(`${path}.backup`)).rejects.toMatchObject({ code: "ENOENT" });
});

test("refuses symlinked database directories and files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "s4imsg-migration-"));
  temporaryDirectories.push(directory);
  const actual = join(directory, "actual");
  await mkdir(actual);
  await symlink(actual, join(directory, "linked"));
  expect(() => openS4imsgDatabase(join(directory, "linked", "state.sqlite"))).toThrow(
    "symbolic link directory",
  );

  const target = join(actual, "target.sqlite");
  const targetDatabase = new Database(target, { create: true });
  targetDatabase.close();
  await symlink(target, join(actual, "state.sqlite"));
  expect(() => openS4imsgDatabase(join(actual, "state.sqlite"))).toThrow(
    "symbolic link database",
  );
});
