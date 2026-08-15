import { Database } from "bun:sqlite";
import { chmodSync, copyFileSync, mkdirSync, statSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { CURRENT_SCHEMA_VERSION, migrateDatabase } from "./migrations";

export function openS4imsgDatabase(
  path: string,
  options: { migrate?: (database: Database) => void } = {},
): Database {
  const directory = dirname(path);
  const backupPath = `${path}.backup`;
  mkdirSync(directory, { mode: 0o700, recursive: true });
  chmodSync(directory, 0o700);
  let existed = false;
  try {
    existed = statSync(path).size > 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  if (existed) {
    const inspection = new Database(path, { strict: true });
    const version = inspection.query("PRAGMA user_version").get() as { user_version: number };
    inspection.close();
    if (version.user_version < CURRENT_SCHEMA_VERSION) {
      copyFileSync(path, backupPath);
      chmodSync(backupPath, 0o600);
    }
  }

  const database = new Database(path, { create: true, strict: true });
  try {
    database.exec("PRAGMA journal_mode = WAL");
    database.exec("PRAGMA foreign_keys = ON");
    database.exec("PRAGMA busy_timeout = 5000");
    (options.migrate ?? migrateDatabase)(database);
    chmodSync(path, 0o600);
    try {
      unlinkSync(backupPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}
