import type { Database } from "bun:sqlite";

export interface ConductorBinding {
  chatKey: string;
  deepLink: string;
  lastMessageId: string | null;
  sessionId: string;
  workspaceId: string;
  workspaceName: string;
}

interface ConductorBindingRow {
  chat_key: string;
  deep_link: string;
  last_message_id: string | null;
  session_id: string;
  workspace_id: string;
  workspace_name: string;
}

function bindingFromRow(row: ConductorBindingRow): ConductorBinding {
  return {
    chatKey: row.chat_key,
    deepLink: row.deep_link,
    lastMessageId: row.last_message_id,
    sessionId: row.session_id,
    workspaceId: row.workspace_id,
    workspaceName: row.workspace_name,
  };
}

export class ConductorBindingStore {
  constructor(
    readonly database: Database,
    readonly now: () => number = Date.now,
  ) {}

  get(chatKey: string): ConductorBinding | null {
    const row = this.database
      .query(
        `SELECT chat_key, workspace_id, workspace_name, session_id, deep_link, last_message_id
         FROM conductor_bindings
         WHERE chat_key = ?`,
      )
      .get(chatKey) as ConductorBindingRow | null;
    return row === null ? null : bindingFromRow(row);
  }

  save(input: Omit<ConductorBinding, "lastMessageId"> & {
    lastMessageId?: string | null;
  }): ConductorBinding {
    const now = this.now();
    this.database
      .query(
        `INSERT INTO conductor_bindings
         (chat_key, workspace_id, workspace_name, session_id, deep_link, last_message_id,
          created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(chat_key) DO UPDATE SET
           workspace_id = excluded.workspace_id,
           workspace_name = excluded.workspace_name,
           session_id = excluded.session_id,
           deep_link = excluded.deep_link,
           last_message_id = excluded.last_message_id,
           updated_at = excluded.updated_at`,
      )
      .run(
        input.chatKey,
        input.workspaceId,
        input.workspaceName,
        input.sessionId,
        input.deepLink,
        input.lastMessageId ?? null,
        now,
        now,
      );
    return this.get(input.chatKey)!;
  }

  updateCursor(chatKey: string, messageId: string): void {
    const result = this.database
      .query(
        `UPDATE conductor_bindings
         SET last_message_id = ?, updated_at = ?
         WHERE chat_key = ?`,
      )
      .run(messageId, this.now(), chatKey);
    if (result.changes !== 1) throw new Error("Conductor binding is unavailable");
  }

  delete(chatKey: string): void {
    this.database.query("DELETE FROM conductor_bindings WHERE chat_key = ?").run(chatKey);
  }

  list(): ConductorBinding[] {
    return (this.database
      .query(
        `SELECT chat_key, workspace_id, workspace_name, session_id, deep_link, last_message_id
         FROM conductor_bindings
         ORDER BY updated_at DESC, chat_key ASC`,
      )
      .all() as ConductorBindingRow[]).map(bindingFromRow);
  }
}
