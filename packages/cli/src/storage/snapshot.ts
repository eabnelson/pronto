import { Database } from "bun:sqlite";
import { chmodSync, existsSync, renameSync, unlinkSync } from "node:fs";

function removeIfPresent(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/**
 * Copies a consistent image of the state database to `snapshotPath` without migrating it.
 * Safe while the listener is running. Returns false when there is no database yet.
 */
export function snapshotDatabase(databasePath: string, snapshotPath: string): boolean {
  removeIfPresent(snapshotPath);
  if (!existsSync(databasePath)) return false;
  const database = new Database(databasePath, { strict: true });
  try {
    database.exec("PRAGMA busy_timeout = 5000");
    database.run("VACUUM INTO ?", [snapshotPath]);
  } finally {
    database.close();
  }
  chmodSync(snapshotPath, 0o600);
  return true;
}

/**
 * Puts the snapshot back only when the database was migrated past `supportedVersion`,
 * which the restored executable would otherwise refuse to open. The listener must be stopped.
 */
export function restoreNewerDatabase(
  databasePath: string,
  snapshotPath: string,
  supportedVersion: number,
): boolean {
  if (!existsSync(snapshotPath) || !existsSync(databasePath)) return false;
  const database = new Database(databasePath, { readonly: true, strict: true });
  let version: number;
  try {
    version = (database.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  } finally {
    database.close();
  }
  if (version <= supportedVersion) return false;
  removeIfPresent(`${databasePath}-wal`);
  removeIfPresent(`${databasePath}-shm`);
  renameSync(snapshotPath, databasePath);
  chmodSync(databasePath, 0o600);
  return true;
}
