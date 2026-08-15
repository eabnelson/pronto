import type { Database } from "bun:sqlite";

export const CURRENT_SCHEMA_VERSION = 1;

const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS delivery_events (
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
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS delivery_events_queue
  ON delivery_events(state, created_at);
CREATE INDEX IF NOT EXISTS delivery_events_chat_queue
  ON delivery_events(chat_key, state, created_at);

CREATE TABLE IF NOT EXISTS chat_memory (
  chat_key TEXT PRIMARY KEY,
  summary TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tagged_exchanges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_guid TEXT NOT NULL UNIQUE,
  chat_key TEXT NOT NULL,
  request TEXT NOT NULL,
  reply TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS tagged_exchanges_chat
  ON tagged_exchanges(chat_key, id);
`;

export function migrateDatabase(database: Database): void {
  const row = database.query("PRAGMA user_version").get() as { user_version: number };
  if (row.user_version > CURRENT_SCHEMA_VERSION) {
    throw new Error(`Database version ${row.user_version} is newer than this s4imsg build`);
  }
  if (row.user_version === CURRENT_SCHEMA_VERSION) return;

  database.transaction(() => {
    if (row.user_version < 1) database.exec(SCHEMA_V1);
    database.exec(`PRAGMA user_version = ${CURRENT_SCHEMA_VERSION}`);
  })();
}
