import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { validSummary } from "../context/compact";
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

  recordToolActivity(providerGuid: string, lease: string, observed: boolean): void {
    this.#requireChange(
      this.database
        .query(
          `UPDATE delivery_events
           SET tool_activity = CASE
             WHEN ? = 1 THEN 1
             WHEN tool_activity IS NULL THEN 0
             ELSE tool_activity
           END,
           updated_at = ?
           WHERE provider_guid = ? AND lease_token = ? AND state = 'running'`,
        )
        .run(observed ? 1 : 0, this.now(), providerGuid, lease).changes,
      "record tool activity",
    );
  }

  accept(
    providerGuid: string,
    lease: string,
    output: { reply: string; summary?: string },
  ): void {
    const reply = output.reply.trim();
    if (reply.length === 0 || reply.length > 4_000) throw new Error("Invalid runtime reply");
    const summary = validSummary(output.summary);
    this.#requireChange(
      this.database
        .query(
          `UPDATE delivery_events
           SET state = 'ready_to_send', accepted_reply = ?, proposed_summary = ?,
               compaction_due = ?, updated_at = ?
           WHERE provider_guid = ? AND lease_token = ? AND state = 'running'`,
        )
        .run(
          reply,
          summary,
          output.summary !== undefined && summary === null ? 1 : 0,
          this.now(),
          providerGuid,
          lease,
        ).changes,
      "accept runtime output",
    );
  }

  beginSend(providerGuid: string, lease: string): void {
    this.#requireChange(
      this.database
        .query(
          `UPDATE delivery_events SET state = 'sending', updated_at = ?
           WHERE provider_guid = ? AND lease_token = ? AND state = 'ready_to_send'`,
        )
        .run(this.now(), providerGuid, lease).changes,
      "begin send",
    );
  }

  confirmDelivery(providerGuid: string, lease: string, outboundGuid: string): void {
    this.database.transaction(() => {
      const event = this.database
        .query(
          `SELECT chat_key, tagged_request, accepted_reply, proposed_summary
           FROM delivery_events
           WHERE provider_guid = ? AND lease_token = ? AND state = 'sending'`,
        )
        .get(providerGuid, lease) as
        | {
            accepted_reply: string;
            chat_key: string;
            proposed_summary: string | null;
            tagged_request: string;
          }
        | null;
      if (event === null) throw new Error("Cannot confirm delivery from the current state");
      promoteMemory(this.database, {
        chatKey: event.chat_key,
        eventGuid: providerGuid,
        reply: event.accepted_reply,
        request: event.tagged_request,
        ...(event.proposed_summary === null ? {} : { summary: event.proposed_summary }),
      });
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

  state(providerGuid: string): DeliveryState | null {
    const row = this.database
      .query("SELECT state FROM delivery_events WHERE provider_guid = ?")
      .get(providerGuid) as { state: DeliveryState } | null;
    return row?.state ?? null;
  }

  recoverInterrupted(): { ambiguous: number; parked: number; resumed: number } {
    return this.database.transaction(() => {
      const now = this.now();
      const resumed = this.database
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
      return { ambiguous, parked, resumed };
    })();
  }

  #requireChange(changes: number, action: string): void {
    if (changes !== 1) throw new Error(`Unable to ${action} from the current journal state`);
  }
}
