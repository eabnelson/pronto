import type { Database } from "bun:sqlite";
import { constants } from "node:fs";
import { access, lstat, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { LocalRuntimeKind } from "../config";
import { canonicalExistingDirectory } from "./workspaces";

const MAX_GIT_MARKER_BYTES = 4_096;

export interface WorktreeBinding {
  agent: LocalRuntimeKind;
  chatKey: string;
  worktreePath: string;
}

interface WorktreeBindingRow {
  chat_key: string;
  runtime_kind: string;
  worktree_path: string;
}

function bindingFromRow(row: WorktreeBindingRow): WorktreeBinding {
  if (row.runtime_kind !== "codex" && row.runtime_kind !== "claude") {
    throw new Error("Stored worktree binding has an invalid agent");
  }
  return {
    agent: row.runtime_kind,
    chatKey: row.chat_key,
    worktreePath: row.worktree_path,
  };
}

async function boundedMarker(path: string, label: string): Promise<string> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_GIT_MARKER_BYTES) {
    throw new Error(`Invalid linked Git worktree ${label}`);
  }
  const contents = await readFile(path, "utf8");
  if (contents.length === 0 || contents.length > MAX_GIT_MARKER_BYTES) {
    throw new Error(`Invalid linked Git worktree ${label}`);
  }
  return contents.trim();
}

export async function canonicalLinkedWorktree(path: string): Promise<string> {
  const canonical = await canonicalExistingDirectory(path);
  const marker = await boundedMarker(join(canonical, ".git"), "marker");
  const match = marker.match(/^gitdir: ([^\r\n]+)$/u);
  if (match === null) throw new Error("Path is not a linked Git worktree");

  const rawGitDirectory = match[1]!;
  const gitDirectory = await realpath(
    isAbsolute(rawGitDirectory)
      ? rawGitDirectory
      : resolve(canonical, rawGitDirectory),
  );
  if (!(await stat(gitDirectory)).isDirectory()) {
    throw new Error("Linked Git worktree metadata is unavailable");
  }
  await access(join(gitDirectory, "HEAD"), constants.R_OK);

  const rawRegisteredMarker = await boundedMarker(
    join(gitDirectory, "gitdir"),
    "registration marker",
  );
  const registeredMarker = await realpath(
    isAbsolute(rawRegisteredMarker)
      ? rawRegisteredMarker
      : resolve(gitDirectory, rawRegisteredMarker),
  );
  if (registeredMarker !== await realpath(join(canonical, ".git"))) {
    throw new Error("Linked Git worktree registration does not match this path");
  }

  const rawCommonDirectory = await boundedMarker(
    join(gitDirectory, "commondir"),
    "common-directory marker",
  );
  const commonDirectory = await realpath(
    isAbsolute(rawCommonDirectory)
      ? rawCommonDirectory
      : resolve(gitDirectory, rawCommonDirectory),
  );
  if (!(await stat(commonDirectory)).isDirectory()) {
    throw new Error("Linked Git worktree common directory is unavailable");
  }
  return canonical;
}

export class WorktreeBindingStore {
  constructor(
    readonly database: Database,
    readonly now: () => number = Date.now,
  ) {}

  bind(input: WorktreeBinding): WorktreeBinding {
    const now = this.now();
    this.database
      .query(
        `INSERT INTO worktree_bindings
         (chat_key, worktree_path, runtime_kind, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(chat_key) DO UPDATE SET
           worktree_path = excluded.worktree_path,
           runtime_kind = excluded.runtime_kind,
           updated_at = excluded.updated_at`,
      )
      .run(input.chatKey, input.worktreePath, input.agent, now, now);
    return this.get(input.chatKey)!;
  }

  delete(chatKey: string): boolean {
    return this.database
      .query("DELETE FROM worktree_bindings WHERE chat_key = ?")
      .run(chatKey).changes === 1;
  }

  get(chatKey: string): WorktreeBinding | null {
    const row = this.database
      .query(
        `SELECT chat_key, worktree_path, runtime_kind
         FROM worktree_bindings
         WHERE chat_key = ?`,
      )
      .get(chatKey) as WorktreeBindingRow | null;
    return row === null ? null : bindingFromRow(row);
  }

  list(): WorktreeBinding[] {
    return (this.database
      .query(
        `SELECT chat_key, worktree_path, runtime_kind
         FROM worktree_bindings
         ORDER BY updated_at DESC, chat_key ASC`,
      )
      .all() as WorktreeBindingRow[]).map(bindingFromRow);
  }
}
