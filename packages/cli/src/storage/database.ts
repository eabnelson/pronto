import { Database } from "bun:sqlite";
import { chmodSync, copyFileSync, lstatSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname, join, parse, resolve } from "node:path";
import { CURRENT_SCHEMA_VERSION, migrateDatabase } from "./migrations";

export function openProntoDatabase(
  path: string,
  options: { migrate?: (database: Database) => void } = {},
): Database {
  const directory = dirname(path);
  const backupPath = `${path}.backup`;
  ensurePrivateDirectorySync(directory);
  let existed = false;
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error(`Refusing symbolic link database: ${path}`);
    if (!stat.isFile()) throw new Error(`Expected a database file: ${path}`);
    existed = stat.size > 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  if (existed) {
    const inspection = new Database(path, { strict: true });
    const version = inspection.query("PRAGMA user_version").get() as { user_version: number };
    inspection.close();
    if (version.user_version < CURRENT_SCHEMA_VERSION) {
      refuseSymlink(backupPath, "database backup");
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

function ensurePrivateDirectorySync(path: string): void {
  const absolutePath = resolve(path);
  const root = parse(absolutePath).root;
  const components = absolutePath.slice(root.length).split("/").filter(Boolean);
  let current = root;

  for (const [index, component] of components.entries()) {
    current = join(current, component);
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) {
        if (allowedMacosSystemAlias(current)) continue;
        throw new Error(`Refusing symbolic link directory: ${current}`);
      }
      if (!stat.isDirectory()) throw new Error(`Expected a directory: ${current}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      mkdirSync(current, { mode: 0o700 });
    }
    if (index === components.length - 1) chmodSync(current, 0o700);
  }
}

function allowedMacosSystemAlias(path: string): boolean {
  return process.platform === "darwin" && ["/etc", "/tmp", "/var"].includes(path);
}

function refuseSymlink(path: string, label: string): void {
  try {
    if (lstatSync(path).isSymbolicLink()) throw new Error(`Refusing symbolic link ${label}: ${path}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
