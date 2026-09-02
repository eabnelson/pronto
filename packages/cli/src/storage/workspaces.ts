import type { Database } from "bun:sqlite";
import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { MAX_WORKSPACE_CANDIDATES } from "../workspace";

function parseCandidates(value: string | null): string[] {
  if (value === null) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed
          .filter((candidate): candidate is string => typeof candidate === "string")
          .slice(0, MAX_WORKSPACE_CANDIDATES)
      : [];
  } catch {
    return [];
  }
}

export async function canonicalExistingDirectory(path: string): Promise<string> {
  const canonical = await realpath(path);
  if (!(await stat(canonical)).isDirectory()) throw new Error(`Expected a directory: ${canonical}`);
  if (/[\u0000-\u001f\u007f]/.test(canonical)) {
    throw new Error(`Directory path contains unsupported control characters: ${canonical}`);
  }
  await access(canonical, constants.R_OK | constants.X_OK);
  return canonical;
}

export interface WorkspaceState {
  activeDirectory: string | null;
  pendingCandidates: string[];
}

export function promoteWorkspace(
  database: Database,
  input: {
    chatKey: string;
    workingDirectory?: string;
    candidates?: readonly string[];
    now?: number;
  },
): void {
  const pendingCandidates =
    input.candidates === undefined
      ? null
      : JSON.stringify([...input.candidates].slice(0, MAX_WORKSPACE_CANDIDATES));
  database
    .query(
      `INSERT INTO chat_workspaces
       (chat_key, active_directory, pending_candidates, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(chat_key) DO UPDATE SET
         active_directory = COALESCE(excluded.active_directory, chat_workspaces.active_directory),
         pending_candidates = excluded.pending_candidates,
         updated_at = excluded.updated_at`,
    )
    .run(
      input.chatKey,
      input.workingDirectory ?? null,
      pendingCandidates,
      input.now ?? Date.now(),
    );
}

export class WorkspaceStore {
  constructor(readonly database: Database) {}

  get(chatKey: string): WorkspaceState {
    const row = this.database
      .query(
        "SELECT active_directory, pending_candidates FROM chat_workspaces WHERE chat_key = ?",
      )
      .get(chatKey) as
      | { active_directory: string | null; pending_candidates: string | null }
      | null;
    return {
      activeDirectory: row?.active_directory ?? null,
      pendingCandidates: parseCandidates(row?.pending_candidates ?? null),
    };
  }

  forget(chatKey: string): void {
    this.database.query("DELETE FROM chat_workspaces WHERE chat_key = ?").run(chatKey);
  }
}
