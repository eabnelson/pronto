import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { validSummary } from "../context/compact";
import type { RuntimeKind } from "../config";
import type { RuntimeAttemptResult, ToolActivity } from "../runtimes/types";
import { isChannelKind, type ChannelKind, type ChatAddress } from "../channels/types";
import { imessageChatId } from "./chat-key";
import { migrateDatabase, MULTI_APP_SCHEMA_VERSION } from "./migrations";
import { promoteMemory } from "./memory";
import { promoteWorkspace } from "./workspaces";
import { MAX_RUNTIME_TEXT_CHARACTERS, MAX_WORKSPACE_CANDIDATES } from "../workspace";

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
  activationTag?: string;
  chat: ChatAddress;
  chatKey: string;
  /** Channel-owned reply scope; stored as JSON until the event settles. */
  conversation?: unknown;
  providerGuid: string;
  request: string;
}

export type QueuedEvent = AdmissionInput &
  (
    | { state: "admitted" }
    | { acceptedAttachmentPath?: string; acceptedReply: string; lease: string; state: "ready_to_send" }
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
  state: "starting" | "degraded" | "failed" | "ready" | "stopped";
  updatedAt: number;
}

export interface ChannelHealth {
  reason?: string;
  state: "starting" | "degraded" | "failed" | "needs_link" | "ready" | "stopped";
  updatedAt: number;
}

const CHANNEL_HEALTH_STATES: readonly ChannelHealth["state"][] =
  ["starting", "degraded", "failed", "needs_link", "ready", "stopped"];

const ACTIVE_STATES = ["admitted", "running", "ready_to_send", "sending"] as const;

/**
 * An accepted reply's staged attachment lives in `service_state` under this prefix plus the
 * event's provider guid, so both the iMessage-only and multi-app schemas can hold it without a
 * migration. It is removed when the delivery outcome settles.
 */
const ATTACHMENT_KEY_PREFIX = "outbound_attachment:";

function parseConversationReference(value: string, chat: ChatAddress): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Stored conversation reference is invalid");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Stored conversation reference is invalid");
  }
  const reference = parsed as Record<string, unknown>;
  const addressed = chat.channel === "imessage"
    ? reference.chatId === imessageChatId(chat) && reference.provider === "apple-messages"
    : reference.chatJid === chat.id && reference.provider === chat.channel;
  if (
    !addressed || reference.version !== 1 || typeof reference.expiresAt !== "string" ||
    typeof reference.token !== "string" || reference.token.length === 0
  ) {
    throw new Error("Stored conversation reference is invalid");
  }
  return reference;
}

export class DeliveryJournal {
  /** Whether the schema stores each event's app and chat address (schema 6+). */
  #multiApp: boolean;

  constructor(
    readonly database: Database,
    readonly now: () => number = Date.now,
  ) {
    const columns = database.query("PRAGMA table_info(delivery_events)").all() as Array<{ name: string }>;
    this.#multiApp = columns.some((column) => column.name === "chat_address");
  }

  /** Upgrades to the multi-app schema when an app other than iMessage is enabled. */
  enableMultiApp(): void {
    if (this.#multiApp) return;
    migrateDatabase(this.database, MULTI_APP_SCHEMA_VERSION);
    this.#multiApp = true;
  }

  admit(input: AdmissionInput): { status: "accepted" | "duplicate" | "rate-limited" } {
    if (input.chat.channel !== "imessage" && !this.#multiApp) {
      throw new Error("This state database stores only iMessage chats; enable the app to upgrade it");
    }
    if (input.chat.id.length === 0 || input.chat.id.length > 256) throw new Error("Invalid chat ID");
    const chatId = input.chat.channel === "imessage" ? imessageChatId(input.chat) : 0;
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
      const addressColumns = this.#multiApp ? ", channel, chat_address" : "";
      const addressValues = this.#multiApp ? ", ?, ?" : "";
      this.database
        .query(
          `INSERT INTO delivery_events
           (provider_guid, chat_key, chat_id, conversation_reference, activation_tag,
            tagged_request, state, created_at, updated_at${addressColumns})
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?${addressValues})`,
        )
        .run(
          input.providerGuid,
          input.chatKey,
          chatId,
          rateLimited || input.conversation === undefined
            ? null
            : JSON.stringify(input.conversation),
          rateLimited ? null : input.activationTag ?? null,
          rateLimited ? null : input.request,
          rateLimited ? "rate_limited" : "admitted",
          now,
          now,
          ...(this.#multiApp ? [input.chat.channel, input.chat.id] : []),
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
        `SELECT provider_guid, chat_key, chat_id, conversation_reference, activation_tag,
                tagged_request, state, accepted_reply, lease_token${
                  this.#multiApp ? ", channel, chat_address" : ""}
         FROM delivery_events
         WHERE state IN ('admitted', 'ready_to_send') AND tagged_request IS NOT NULL
         ORDER BY created_at ASC, rowid ASC
         LIMIT 1`,
      )
      .get() as
      | {
          channel?: string;
          chat_address?: string | null;
          chat_id: number;
          chat_key: string;
          conversation_reference: string | null;
          activation_tag: string | null;
          provider_guid: string;
          tagged_request: string;
          state: "admitted" | "ready_to_send";
          accepted_reply: string | null;
          lease_token: string | null;
        }
      | null;
    if (row === null) return null;
    const chat = this.#storedChat(row);
    const event = {
      chat,
      chatKey: row.chat_key,
      ...(row.conversation_reference === null
        ? {}
        : { conversation: parseConversationReference(row.conversation_reference, chat) }),
      providerGuid: row.provider_guid,
      request: row.tagged_request,
      ...(row.activation_tag === null ? {} : { activationTag: row.activation_tag }),
    };
    if (row.state === "admitted") return { ...event, state: "admitted" };
    if (row.accepted_reply === null || row.lease_token === null) {
      throw new Error("Ready delivery is missing its accepted output or lease");
    }
    const attachment = this.database
      .query("SELECT value FROM service_state WHERE key = ?")
      .get(`${ATTACHMENT_KEY_PREFIX}${row.provider_guid}`) as { value: string } | null;
    return {
      ...event,
      ...(attachment === null ? {} : { acceptedAttachmentPath: attachment.value }),
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
      (state !== "starting" && state !== "degraded" && state !== "failed" && state !== "ready" && state !== "stopped") ||
      !Number.isSafeInteger(updatedAt) ||
      updatedAt <= 0
    ) {
      return null;
    }
    return { state, updatedAt };
  }

  recordChannelHealth(channel: ChannelKind, state: ChannelHealth["state"], reason?: string): void {
    const health: ChannelHealth = {
      ...(reason === undefined ? {} : { reason: reason.slice(0, 64) }),
      state,
      updatedAt: this.now(),
    };
    this.database
      .query(
        `INSERT INTO service_state (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(`channel_health:${channel}`, JSON.stringify(health));
  }

  channelHealth(): Partial<Record<ChannelKind, ChannelHealth>> {
    const rows = this.database
      .query("SELECT key, value FROM service_state WHERE key LIKE 'channel_health:%'")
      .all() as Array<{ key: string; value: string }>;
    const health: Partial<Record<ChannelKind, ChannelHealth>> = {};
    for (const row of rows) {
      const channel = row.key.slice("channel_health:".length);
      if (!isChannelKind(channel)) continue;
      try {
        const value = JSON.parse(row.value) as Partial<ChannelHealth>;
        if (
          CHANNEL_HEALTH_STATES.includes(value.state as ChannelHealth["state"]) &&
          Number.isSafeInteger(value.updatedAt) &&
          (value.reason === undefined || typeof value.reason === "string")
        ) {
          health[channel] = value as ChannelHealth;
        }
      } catch {
        continue;
      }
    }
    return health;
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
             WHEN ? = 0 AND tool_activity = 2 THEN 0
             WHEN tool_activity IS NULL THEN 0
             ELSE tool_activity
           END,
           updated_at = ?
           WHERE provider_guid = ? AND lease_token = ? AND state = 'running'`,
        )
        .run(value, value, value, this.now(), providerGuid, lease).changes,
      "record tool activity",
    );
  }

  beginRuntimeAttempt(providerGuid: string, lease: string): void {
    this.#requireChange(
      this.database
        .query(
          `UPDATE delivery_events
           SET tool_activity = CASE WHEN tool_activity = 1 THEN 1 ELSE 2 END,
               updated_at = ?
           WHERE provider_guid = ? AND lease_token = ? AND state = 'running'`,
        )
        .run(this.now(), providerGuid, lease).changes,
      "begin runtime attempt",
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
    output: {
      /** Absolute path of the staged file to send with the reply. */
      attachmentPath?: string;
      reply: string;
      summary?: string;
      workingDirectory?: string;
      workspaceCandidates?: readonly string[];
    },
    options: { memoryEligible?: boolean } = {},
  ): void {
    const reply = output.reply.trim();
    if (reply.length === 0 || reply.length > MAX_RUNTIME_TEXT_CHARACTERS) {
      throw new Error("Invalid runtime reply");
    }
    if (output.attachmentPath !== undefined && !isAbsolute(output.attachmentPath)) {
      throw new Error("Invalid staged attachment path");
    }
    const summary = validSummary(output.summary);
    this.database.transaction(() => {
      this.#requireChange(
        this.database
          .query(
            `UPDATE delivery_events
             SET state = 'ready_to_send', accepted_reply = ?, proposed_summary = ?,
                 proposed_working_directory = ?, proposed_workspace_candidates = ?,
                 compaction_due = ?, memory_eligible = ?, updated_at = ?
             WHERE provider_guid = ? AND lease_token = ? AND state = 'running'`,
          )
          .run(
            reply,
            summary,
            output.workingDirectory ?? null,
            output.workspaceCandidates === undefined
              ? null
              : JSON.stringify(output.workspaceCandidates.slice(0, MAX_WORKSPACE_CANDIDATES)),
            output.summary !== undefined && summary === null ? 1 : 0,
            options.memoryEligible === false ? 0 : 1,
            this.now(),
            providerGuid,
            lease,
          ).changes,
        "accept runtime output",
      );
      if (output.attachmentPath === undefined) this.#forgetAttachment(providerGuid);
      else {
        this.database
          .query(
            `INSERT INTO service_state (key, value) VALUES (?, ?)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
          )
          .run(`${ATTACHMENT_KEY_PREFIX}${providerGuid}`, output.attachmentPath);
      }
    })();
  }

  /** Staged attachments still waiting to be sent; every other staged file may be deleted. */
  pendingAttachmentPaths(): string[] {
    const rows = this.database
      .query(
        `SELECT service_state.value FROM service_state
         JOIN delivery_events
           ON service_state.key = ? || delivery_events.provider_guid
         WHERE service_state.key LIKE ? AND delivery_events.state = 'ready_to_send'`,
      )
      .all(ATTACHMENT_KEY_PREFIX, `${ATTACHMENT_KEY_PREFIX}%`) as Array<{ value: string }>;
    return rows.map((row) => row.value);
  }

  beginSend(providerGuid: string, lease: string, chat?: ChatAddress, text?: string): void {
    const fingerprint =
      chat === undefined || text === undefined ? null : this.#fingerprint(chat, text);
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
          `SELECT chat_key, tagged_request, accepted_reply, proposed_summary, memory_eligible,
                  proposed_working_directory, proposed_workspace_candidates
           FROM delivery_events
           WHERE provider_guid = ? AND lease_token = ? AND state = 'sending'`,
        )
        .get(providerGuid, lease) as
        | {
            accepted_reply: string;
            chat_key: string;
            memory_eligible: number;
            proposed_summary: string | null;
            proposed_working_directory: string | null;
            proposed_workspace_candidates: string | null;
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
      let candidates: string[] | undefined;
      if (event.proposed_workspace_candidates !== null) {
        const parsed: unknown = JSON.parse(event.proposed_workspace_candidates);
        if (Array.isArray(parsed) && parsed.every((value) => typeof value === "string")) {
          candidates = parsed.slice(0, MAX_WORKSPACE_CANDIDATES);
        }
      }
      if (event.proposed_working_directory !== null || candidates !== undefined) {
        promoteWorkspace(this.database, {
          ...(candidates === undefined ? {} : { candidates }),
          chatKey: event.chat_key,
          ...(event.proposed_working_directory === null
            ? {}
            : { workingDirectory: event.proposed_working_directory }),
          now: this.now(),
        });
      }
      this.database
        .query(
          `UPDATE delivery_events
           SET state = 'delivered', outbound_guid = ?, activation_tag = NULL,
               conversation_reference = NULL,
               tagged_request = NULL,
               accepted_reply = NULL, proposed_summary = NULL,
               proposed_working_directory = NULL, proposed_workspace_candidates = NULL,
               updated_at = ?
           WHERE provider_guid = ? AND lease_token = ?`,
        )
        .run(outboundGuid, this.now(), providerGuid, lease);
      this.#forgetAttachment(providerGuid);
    })();
  }

  markAmbiguous(providerGuid: string, lease: string): void {
    this.#requireChange(
      this.database
        .query(
          `UPDATE delivery_events
           SET state = 'ambiguous', conversation_reference = NULL, updated_at = ?
           WHERE provider_guid = ? AND lease_token = ? AND state = 'sending'`,
        )
        .run(this.now(), providerGuid, lease).changes,
      "mark delivery ambiguous",
    );
    this.#forgetAttachment(providerGuid);
  }

  markFailed(providerGuid: string, lease: string): void {
    this.#requireChange(
      this.database
        .query(
          `UPDATE delivery_events
           SET state = 'failed', activation_tag = NULL, tagged_request = NULL,
               accepted_reply = NULL, conversation_reference = NULL,
               proposed_summary = NULL, proposed_working_directory = NULL,
               proposed_workspace_candidates = NULL, outbound_fingerprint = NULL,
               outbound_fingerprint_expires_at = NULL, updated_at = ?
           WHERE provider_guid = ? AND lease_token = ?
             AND state IN ('running', 'ready_to_send', 'sending')`,
        )
        .run(this.now(), providerGuid, lease).changes,
      "mark delivery failed",
    );
    this.#forgetAttachment(providerGuid);
  }

  markParked(providerGuid: string, lease: string): void {
    this.#requireChange(
      this.database
        .query(
          `UPDATE delivery_events
           SET state = 'parked', conversation_reference = NULL, updated_at = ?
           WHERE provider_guid = ? AND lease_token = ? AND state = 'running'`,
        )
        .run(this.now(), providerGuid, lease).changes,
      "park delivery",
    );
  }

  matchesOutboundEcho(chat: ChatAddress, text: string): boolean {
    const fingerprint = this.#fingerprint(chat, text);
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
               UNION SELECT chat_key FROM chat_workspaces
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
      this.database
        .query(
          `DELETE FROM service_state
           WHERE key LIKE ? AND substr(key, ?) NOT IN (
             SELECT provider_guid FROM delivery_events WHERE state = 'ready_to_send'
           )`,
        )
        .run(`${ATTACHMENT_KEY_PREFIX}%`, ATTACHMENT_KEY_PREFIX.length + 1);
      return { ambiguous, parked, resumed: replayed + readyToSend.count };
    })();
  }

  #storedChat(row: { channel?: string; chat_address?: string | null; chat_id: number }): ChatAddress {
    if (row.channel === undefined || row.channel === "imessage") {
      return { channel: "imessage", id: String(row.chat_id) };
    }
    if (!isChannelKind(row.channel) || typeof row.chat_address !== "string") {
      throw new Error("Stored chat address is invalid");
    }
    return { channel: row.channel, id: row.chat_address };
  }

  #forgetAttachment(providerGuid: string): void {
    this.database
      .query("DELETE FROM service_state WHERE key = ?")
      .run(`${ATTACHMENT_KEY_PREFIX}${providerGuid}`);
  }

  #requireChange(changes: number, action: string): void {
    if (changes !== 1) throw new Error(`Unable to ${action} from the current journal state`);
  }

  #fingerprint(chat: ChatAddress, text: string): string {
    // iMessage keeps the original input so fingerprints recorded before an upgrade still match.
    const scope = chat.channel === "imessage" ? chat.id : `${chat.channel}:${chat.id}`;
    return createHash("sha256").update(`${scope}\0${text}`).digest("base64url");
  }
}
