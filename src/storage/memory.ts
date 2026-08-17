import type { Database } from "bun:sqlite";
import { validSummary } from "../context/compact";

export interface TaggedExchange {
  request: string;
  reply: string;
}

export interface ChatMemory {
  exchanges: TaggedExchange[];
  summary: string | null;
}

export interface PromoteMemoryInput extends TaggedExchange {
  chatKey: string;
  eventGuid: string;
  summary?: string;
}

export function promoteMemory(
  database: Database,
  input: PromoteMemoryInput,
  now = Date.now(),
): void {
  database
    .query(
      `INSERT OR IGNORE INTO tagged_exchanges
       (event_guid, chat_key, request, reply, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(input.eventGuid, input.chatKey, input.request, input.reply, now);

  const summary = validSummary(input.summary);
  if (summary !== null) {
    database
      .query(
        `INSERT INTO chat_memory (chat_key, summary, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(chat_key) DO UPDATE SET
           summary = excluded.summary,
           updated_at = excluded.updated_at`,
      )
      .run(input.chatKey, summary, now);
  }

  database
    .query(
      `DELETE FROM tagged_exchanges
       WHERE chat_key = ?
         AND id NOT IN (
           SELECT id FROM tagged_exchanges
           WHERE chat_key = ?
           ORDER BY id DESC
           LIMIT 8
         )`,
    )
    .run(input.chatKey, input.chatKey);
}

export class MemoryStore {
  constructor(readonly database: Database) {}

  promote(input: PromoteMemoryInput): void {
    this.database.transaction(() => promoteMemory(this.database, input))();
  }

  get(chatKey: string): ChatMemory {
    const summary = this.database
      .query("SELECT summary FROM chat_memory WHERE chat_key = ?")
      .get(chatKey) as { summary: string | null } | null;
    const exchanges = this.database
      .query(
        `SELECT request, reply FROM tagged_exchanges
         WHERE chat_key = ?
         ORDER BY id ASC`,
      )
      .all(chatKey) as TaggedExchange[];
    return { exchanges, summary: summary?.summary ?? null };
  }

  forget(chatKey: string): void {
    this.database.transaction(() => {
      this.database.query("DELETE FROM tagged_exchanges WHERE chat_key = ?").run(chatKey);
      this.database.query("DELETE FROM chat_memory WHERE chat_key = ?").run(chatKey);
      this.database.query("DELETE FROM chat_workspaces WHERE chat_key = ?").run(chatKey);
      this.database
        .query(
          `UPDATE delivery_events
           SET state = CASE
                 WHEN state IN ('admitted', 'running', 'ready_to_send', 'sending') THEN 'failed'
                 ELSE state
               END,
               tagged_request = NULL, accepted_reply = NULL, proposed_summary = NULL,
               proposed_working_directory = NULL, proposed_workspace_candidates = NULL
           WHERE chat_key = ?`,
        )
        .run(chatKey);
    })();
  }
}
