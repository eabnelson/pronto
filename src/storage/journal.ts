import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { validSummary } from "../context/compact";
import type { RuntimeKind } from "../config";
import type { RuntimeAttemptResult, ToolActivity } from "../runtimes/types";
import { promoteMemory } from "./memory";

export type DeliveryState =
  | "admitted"
  | "running"
  | "ready_to_send"
  | "sending"
  | "delivered"
  | "failed"
  | "ambiguous"
  | "parked"
  | "rate_limited";

export interface AdmissionInput {
  chatId: number;
  chatKey: string;
  providerGuid: string;
  request: string;
}

export type QueuedEvent = AdmissionInput &
  (
    | { state: "admitted" }
    | { acceptedReply: string; lease: string; state: "ready_to_send" }
  );

export interface OperationalStatus {
  active: number;
  ambiguous: number;
  chats?: string[];
  lastSettledAt: number | null;
  parked: number;
  rateLimited: number;
}

export interface DaemonHealth {
  state: "failed" | "ready" | "stopped";
  updatedAt: number;
}

const ACTIVE_STATES = ["admitted", "running", "ready_to_send", "sending"] as const;

export class DeliveryJournal {
  constructor(
    readonly database: Database,
    readonly now: () => number = Date.now,
  ) {}

  admit(input: AdmissionInput): { status: "accepted" | "duplicate" | "rate-limited" } {
    return this.database.transaction(() => {
      const existing = this.database
        .query("SELECT 1 AS present FROM delivery_events WHERE provider_guid = ?")
        .get(input.providerGuid);
      if (existing !== null) return { status: "duplicate" as const };

      const placeholders = ACTIVE_STATES.map(() => "?").join(", ");
      const global = this.database
        .query(`SELECT COUNT(*) AS count FROM delivery_events WHERE state IN (${placeholders})`)
        .get(...ACTIVE_STATES) as { count: number };
      const perChat = this.database
        .query(
          `SELECT COUNT(*) AS count FROM delivery_events
           WHERE chat_key = ? AND state IN (${placeholders})`,
        )
        .get(input.chatKey, ...ACTIVE_STATES) as { count: number };
      const rateLimited = global.count >= 32 || perChat.count >= 4;
      const now = this.now();
      this.database
        .query(
          `INSERT INTO delivery_events
           (provider_guid, chat_key, chat_id, tagged_request, state, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.providerGuid,
          input.chatKey,
          input.chatId,
          rateLimited ? null : input.request,
          rateLimited ? "rate_limited" : "admitted",
          now,
          now,
        );
      return { status: rateLimited ? ("rate-limited" as const) : ("accepted" as const) };
    })();
  }

  lease(providerGuid: string): string | null {
    const token = randomUUID();
    const result = this.database
      .query(
        `UPDATE delivery_events
         SET state = 'running', lease_token = ?, tool_activity = NULL, updated_at = ?
         WHERE provider_guid = ? AND state = 'admitted'`,
      )
      .run(token, this.now(), providerGuid);
    return result.changes === 1 ? token : null;
  }

  nextRunnable(): QueuedEvent | null {
    const row = this.database
      .query(
        `SELECT provider_guid, chat_key, chat_id, tagged_request, state,
                accepted_reply, lease_token
         FROM delivery_events
         WHERE state IN ('admitted', 'ready_to_send') AND tagged_request IS NOT NULL
         ORDER BY created_at ASC, rowid ASC
         LIMIT 1`,
      )
      .get() as
      | {
          chat_id: number;
          chat_key: string;
          provider_guid: string;
          tagged_request: string;
          state: "admitted" | "ready_to_send";
          accepted_reply: string | null;
          lease_token: string | null;
        }
      | null;
    if (row === null) return null;
    const event = {
      chatId: row.chat_id,
      chatKey: row.chat_key,
      providerGuid: row.provider_guid,
      request: row.tagged_request,
    };
    if (row.state === "admitted") return { ...event, state: "admitted" };
    if (row.accepted_reply === null || row.lease_token === null) {
      throw new Error("Ready delivery is missing its accepted output or lease");
    }
    return {
      ...event,
      acceptedReply: row.accepted_reply,
      lease: row.lease_token,
      state: "ready_to_send",
    };
  }

  cursor(): number | undefined {
    const row = this.database
      .query("SELECT value FROM service_state WHERE key = 'message_cursor'")
      .get() as { value: string } | null;
    if (row === null) return undefined;
    const value = Number(row.value);
    return Number.isSafeInteger(value) && value > 0 ? value : undefined;
  }

  advanceCursor(rowId: number): void {
    if (!Number.isSafeInteger(rowId) || rowId <= 0) throw new Error("Invalid message cursor");
    this.database
      .query(
        `INSERT INTO service_state (key, value) VALUES ('message_cursor', ?)
         ON CONFLICT(key) DO UPDATE SET value = CASE
           WHEN CAST(value AS INTEGER) < CAST(excluded.value AS INTEGER) THEN excluded.value
           ELSE value
         END`,
      )
      .run(String(rowId));
  }

  recordDaemonHealth(state: DaemonHealth["state"]): void {
    this.database.transaction(() => {
      for (const [key, value] of [
        ["daemon_state", state],
        ["daemon_updated_at", String(this.now())],
      ] as const) {
        this.database
          .query(
            `INSERT INTO service_state (key, value) VALUES (?, ?)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
          )
          .run(key, value);
      }
    })();
  }

  daemonHealth(): DaemonHealth | null {
    const rows = this.database
      .query("SELECT key, value FROM service_state WHERE key IN ('daemon_state', 'daemon_updated_at')")
      .all() as Array<{ key: string; value: string }>;
    const values = new Map(rows.map((row) => [row.key, row.value]));
    const state = values.get("daemon_state");
    const updatedAt = Number(values.get("daemon_updated_at"));
    if (
      (state !== "failed" && state !== "ready" && state !== "stopped") ||
      !Number.isSafeInteger(updatedAt) ||
      updatedAt <= 0
    ) {
      return null;
    }
    return { state, updatedAt };
  }

  recordDegradedCapabilities(capabilities: readonly string[]): void {
    const bounded = [...new Set(capabilities.filter((value) => /^[a-z0-9_-]{1,64}$/.test(value)))]
      .sort()
      .slice(0, 32);
    this.database
      .query(
        `INSERT INTO service_state (key, value) VALUES ('degraded_capabilities', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(JSON.stringify(bounded));
  }

  degradedCapabilities(): string[] {
    const row = this.database
      .query("SELECT value FROM service_state WHERE key = 'degraded_capabilities'")
      .get() as { value: string } | null;
    if (row === null) return [];
    try {
      const parsed: unknown = JSON.parse(row.value);
      return Array.isArray(parsed)
        ? parsed.filter((value): value is string => typeof value === "string")
        : [];
    } catch {
      return [];
    }
  }

  recordToolActivity(
    providerGuid: string,
    lease: string,
    activity: boolean | ToolActivity,
  ): void {
    const value =
      activity === true || activity === "observed" ? 1 : activity === "unknown" ? 2 : 0;
    this.#requireChange(
      this.database
        .query(
          `UPDATE delivery_events
           SET tool_activity = CASE
             WHEN ? = 1 THEN 1
             WHEN ? = 2 AND COALESCE(tool_activity, 0) != 1 THEN 2
             WHEN tool_activity IS NULL THEN 0
             ELSE tool_activity
           END,
           updated_at = ?
           WHERE provider_guid = ? AND lease_token = ? AND state = 'running'`,
        )
        .run(value, value, this.now(), providerGuid, lease).changes,
      "record tool activity",
    );
  }

  recordAttempt(
    providerGuid: string,
    runtime: RuntimeKind,
    result: RuntimeAttemptResult,
  ): void {
    this.database
      .query(
        `INSERT INTO runtime_attempts
         (provider_guid, runtime_kind, outcome, failure_code, tool_activity, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        providerGuid,
        runtime,
        result.status,
        result.status === "success" ? null : result.reason,
        result.toolActivity === "observed" ? 1 : result.toolActivity === "unknown" ? 2 : 0,
        this.now(),
      );
  }

  accept(
    providerGuid: string,
    lease: string,
    output: { reply: string; summary?: string },
    options: { memoryEligible?: boolean } = {},
  ): void {
    const reply = output.reply.trim();
    if (reply.length === 0 || reply.length > 4_000) throw new Error("Invalid runtime reply");
    const summary = validSummary(output.summary);
    this.#requireChange(
      this.database
        .query(
          `UPDATE delivery_events
           SET state = 'ready_to_send', accepted_reply = ?, proposed_summary = ?,
               compaction_due = ?, memory_eligible = ?, updated_at = ?
           WHERE provider_guid = ? AND lease_token = ? AND state = 'running'`,
        )
        .run(
          reply,
          summary,
          output.summary !== undefined && summary === null ? 1 : 0,
          options.memoryEligible === false ? 0 : 1,
          this.now(),
          providerGuid,
          lease,
        ).changes,
      "accept runtime output",
    );
  }

  beginSend(providerGuid: string, lease: string, chatId?: number, text?: string): void {
    const fingerprint =
      chatId === undefined || text === undefined ? null : this.#fingerprint(chatId, text);
    this.#requireChange(
      this.database
        .query(
          `UPDATE delivery_events
           SET state = 'sending', outbound_fingerprint = ?,
               outbound_fingerprint_expires_at = ?, updated_at = ?
           WHERE provider_guid = ? AND lease_token = ? AND state = 'ready_to_send'`,
        )
        .run(
          fingerprint,
          fingerprint === null ? null : this.now() + 24 * 60 * 60 * 1_000,
          this.now(),
          providerGuid,
          lease,
        ).changes,
      "begin send",
    );
  }

  confirmDelivery(providerGuid: string, lease: string, outboundGuid: string): void {
    this.database.transaction(() => {
      const event = this.database
        .query(
          `SELECT chat_key, tagged_request, accepted_reply, proposed_summary, memory_eligible
           FROM delivery_events
           WHERE provider_guid = ? AND lease_token = ? AND state = 'sending'`,
        )
        .get(providerGuid, lease) as
        | {
            accepted_reply: string;
            chat_key: string;
            memory_eligible: number;
            proposed_summary: string | null;
            tagged_request: string;
          }
        | null;
      if (event === null) throw new Error("Cannot confirm delivery from the current state");
      if (event.memory_eligible === 1) {
        promoteMemory(this.database, {
          chatKey: event.chat_key,
          eventGuid: providerGuid,
          reply: event.accepted_reply,
          request: event.tagged_request,
          ...(event.proposed_summary === null ? {} : { summary: event.proposed_summary }),
        });
      }
      this.database
        .query(
          `UPDATE delivery_events
           SET state = 'delivered', outbound_guid = ?, tagged_request = NULL,
               accepted_reply = NULL, proposed_summary = NULL, updated_at = ?
           WHERE provider_guid = ? AND lease_token = ?`,
        )
        .run(outboundGuid, this.now(), providerGuid, lease);
    })();
  }

  markAmbiguous(providerGuid: string, lease: string): void {
    this.#requireChange(
      this.database
        .query(
          `UPDATE delivery_events SET state = 'ambiguous', updated_at = ?
           WHERE provider_guid = ? AND lease_token = ? AND state = 'sending'`,
        )
        .run(this.now(), providerGuid, lease).changes,
      "mark delivery ambiguous",
    );
  }

  markFailed(providerGuid: string, lease: string): void {
    this.#requireChange(
      this.database
        .query(
          `UPDATE delivery_events
           SET state = 'failed', tagged_request = NULL, accepted_reply = NULL,
               proposed_summary = NULL, outbound_fingerprint = NULL,
               outbound_fingerprint_expires_at = NULL, updated_at = ?
           WHERE provider_guid = ? AND lease_token = ?
             AND state IN ('running', 'ready_to_send', 'sending')`,
        )
        .run(this.now(), providerGuid, lease).changes,
      "mark delivery failed",
    );
  }

  markParked(providerGuid: string, lease: string): void {
    this.#requireChange(
      this.database
        .query(
          `UPDATE delivery_events SET state = 'parked', updated_at = ?
           WHERE provider_guid = ? AND lease_token = ? AND state = 'running'`,
        )
        .run(this.now(), providerGuid, lease).changes,
      "park delivery",
    );
  }

  matchesOutboundEcho(chatId: number, text: string): boolean {
    const fingerprint = this.#fingerprint(chatId, text);
    return this.database.transaction(() => {
      this.database
        .query(
          `UPDATE delivery_events
           SET outbound_fingerprint = NULL, outbound_fingerprint_expires_at = NULL
           WHERE outbound_fingerprint_expires_at <= ?`,
        )
        .run(this.now());
      const row = this.database
        .query(
          `SELECT provider_guid FROM delivery_events
           WHERE outbound_fingerprint = ? AND outbound_fingerprint_expires_at > ?
           LIMIT 1`,
        )
        .get(fingerprint, this.now()) as { provider_guid: string } | null;
      if (row === null) return false;
      this.database
        .query(
          `UPDATE delivery_events
           SET outbound_fingerprint = NULL, outbound_fingerprint_expires_at = NULL
           WHERE provider_guid = ?`,
        )
        .run(row.provider_guid);
      return true;
    })();
  }

  state(providerGuid: string): DeliveryState | null {
    const row = this.database
      .query("SELECT state FROM delivery_events WHERE provider_guid = ?")
      .get(providerGuid) as { state: DeliveryState } | null;
    return row?.state ?? null;
  }

  operationalStatus(includeChats = false): OperationalStatus {
    const counts = this.database
      .query(
        `SELECT
           SUM(CASE WHEN state IN ('admitted', 'running', 'ready_to_send', 'sending') THEN 1 ELSE 0 END) AS active,
           SUM(CASE WHEN state = 'ambiguous' THEN 1 ELSE 0 END) AS ambiguous,
           SUM(CASE WHEN state = 'parked' THEN 1 ELSE 0 END) AS parked,
           SUM(CASE WHEN state = 'rate_limited' THEN 1 ELSE 0 END) AS rate_limited,
           MAX(CASE WHEN state IN ('delivered', 'failed', 'ambiguous', 'parked', 'rate_limited')
             THEN updated_at ELSE NULL END) AS last_settled_at
         FROM delivery_events`,
      )
      .get() as {
      active: number | null;
      ambiguous: number | null;
      last_settled_at: number | null;
      parked: number | null;
      rate_limited: number | null;
    };
    const chats = includeChats
      ? (this.database
          .query(
            `SELECT chat_key FROM (
               SELECT chat_key FROM tagged_exchanges
               UNION SELECT chat_key FROM chat_memory
               UNION SELECT chat_key FROM delivery_events
             ) ORDER BY chat_key`,
          )
          .all() as Array<{ chat_key: string }>).map((row) => row.chat_key)
      : undefined;
    return {
      active: counts.active ?? 0,
      ambiguous: counts.ambiguous ?? 0,
      ...(chats === undefined ? {} : { chats }),
      lastSettledAt: counts.last_settled_at,
      parked: counts.parked ?? 0,
      rateLimited: counts.rate_limited ?? 0,
    };
  }

  recoverInterrupted(): { ambiguous: number; parked: number; resumed: number } {
    return this.database.transaction(() => {
      const now = this.now();
      const readyToSend = this.database
        .query("SELECT COUNT(*) AS count FROM delivery_events WHERE state = 'ready_to_send'")
        .get() as { count: number };
      const replayed = this.database
        .query(
          `UPDATE delivery_events
           SET state = 'admitted', lease_token = NULL, resume_count = resume_count + 1,
               updated_at = ?
           WHERE state = 'running' AND tool_activity = 0 AND resume_count = 0`,
        )
        .run(now).changes;
      const parked = this.database
        .query(
          `UPDATE delivery_events
           SET state = 'parked', updated_at = ?
           WHERE state = 'running'`,
        )
        .run(now).changes;
      const ambiguous = this.database
        .query(
          `UPDATE delivery_events
           SET state = 'ambiguous', updated_at = ?
           WHERE state = 'sending'`,
        )
        .run(now).changes;
      return { ambiguous, parked, resumed: replayed + readyToSend.count };
    })();
  }

  #requireChange(changes: number, action: string): void {
    if (changes !== 1) throw new Error(`Unable to ${action} from the current journal state`);
  }

  #fingerprint(chatId: number, text: string): string {
    return createHash("sha256").update(`${chatId}\0${text}`).digest("base64url");
  }
}
