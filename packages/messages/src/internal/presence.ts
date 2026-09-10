import type {
  ConversationReference, MessagesPresence, MessagesPresenceStatus, PresenceOutcome,
} from "../types.js";
import { ImsgRpcClient, RpcRequestError } from "./rpc.js";
import { record } from "./normalize.js";

const REACTIONS = new Set(["love", "like", "dislike", "laugh", "emphasis", "question"]);
const REQUEST_TIMEOUT_MS = 2_000;

/** Separate, non-restarting process: optional mutations never occupy the reply lane. */
export class ScopedMessagesPresence implements MessagesPresence {
  readonly #command: string;
  readonly #enabled: boolean;
  readonly #validate: (reference: ConversationReference) => Promise<void>;
  #rpc: ImsgRpcClient | undefined;
  #uncertain = false;
  #closed = false;
  #busy = false;

  constructor(input: {
    command: string;
    enabled: boolean;
    validate: (reference: ConversationReference) => Promise<void>;
  }) {
    this.#command = input.command;
    this.#enabled = input.enabled;
    this.#validate = input.validate;
  }

  async status(): Promise<MessagesPresenceStatus> {
    const unavailable = (reason: MessagesPresenceStatus["reason"]): MessagesPresenceStatus =>
      ({ reactions: false, typing: false, reason });
    if (!this.#enabled) return unavailable("disabled");
    if (this.#uncertain) return unavailable("mutation_uncertain");
    if (this.#closed) return unavailable("provider_unavailable");
    try {
      const snapshot = record(await this.#client().request("status", {}, REQUEST_TIMEOUT_MS));
      const bridge = record(snapshot.bridge);
      if (bridge.ready !== true || bridge.v2_ready !== true || bridge.registry_available !== true) {
        return unavailable("bridge_unavailable");
      }
      const methods = Array.isArray(snapshot.methods) ? snapshot.methods : [];
      const selectors = record(bridge.selectors);
      const reactions = methods.includes("tapback") && selectors.sendReaction === true;
      const typing = methods.includes("typing") && selectors.typing === true;
      return {
        reason: reactions && typing ? "ready" : "bridge_unavailable",
        reactions,
        typing,
      };
    } catch { return unavailable("provider_unavailable"); }
  }

  async react(input: Parameters<MessagesPresence["react"]>[0]): Promise<PresenceOutcome> {
    const part = input.partIndex ?? 0;
    if (!REACTIONS.has(input.reaction) || !Number.isSafeInteger(part) || part < 0 ||
        !Number.isSafeInteger(input.target.rowId) || input.target.rowId < 1 ||
        !/^[^\s\u0000-\u001f/]{1,1024}$/u.test(input.target.providerMessageId) ||
        (input.remove !== undefined && typeof input.remove !== "boolean")) {
      return { status: "failed", retryable: false };
    }
    return await this.#mutate(input.conversation, "reactions", async () => {
      const page = record(await this.#client().request("messages.after", {
        chat_id: input.conversation.chatId, since_rowid: input.target.rowId - 1,
        limit: 1, include_reactions: true,
      }, REQUEST_TIMEOUT_MS));
      const target = Array.isArray(page.messages) && page.messages.length === 1
        ? record(page.messages[0]) : {};
      if (target.id !== input.target.rowId || target.guid !== input.target.providerMessageId ||
          target.chat_id !== input.conversation.chatId) return undefined;
      return {
        method: "tapback",
        params: {
          chat_id: input.conversation.chatId, message_guid: input.target.providerMessageId,
          reaction: input.reaction, part_index: part,
          ...(input.remove === undefined ? {} : { remove: input.remove }),
        },
      };
    });
  }

  async setTyping(input: Parameters<MessagesPresence["setTyping"]>[0]): Promise<PresenceOutcome> {
    if (typeof input.typing !== "boolean") return { status: "failed", retryable: false };
    return await this.#mutate(input.conversation, "typing", async () => ({
      method: "typing", params: { chat_id: input.conversation.chatId, typing: input.typing },
    }));
  }

  async close(): Promise<void> {
    this.#closed = true;
    await this.#rpc?.close();
  }

  #client(): ImsgRpcClient {
    if (this.#closed) throw new Error("messages_presence_closed");
    return this.#rpc ??= new ImsgRpcClient(this.#command);
  }

  async #mutate(
    conversation: ConversationReference,
    capability: "typing" | "reactions",
    prepare: () => Promise<{ method: string; params: Record<string, unknown> } | undefined>,
  ): Promise<PresenceOutcome> {
    // Drop competing optional work instead of building a queue of stale typing refreshes.
    if (this.#busy) return { status: "unavailable" };
    this.#busy = true;
    let submitted = false;
    const deadline = Date.now() + 5_000;
    const beforeDeadline = async <T>(work: Promise<T>): Promise<T> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([work, new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("messages_presence_prepare_timeout")),
            Math.max(1, deadline - Date.now()));
        })]);
      } finally { if (timer !== undefined) clearTimeout(timer); }
    };
    try {
      if (!(await this.status())[capability]) return { status: "unavailable" };
      await beforeDeadline(this.#validate(conversation));
      const operation = await beforeDeadline(prepare());
      if (operation === undefined) return { status: "failed", retryable: false };
      // Revalidate after reads; never send to a replaced database/changed route.
      await beforeDeadline(this.#validate(conversation));
      if (this.#closed || this.#uncertain || Date.now() >= deadline) return { status: "unavailable" };
      submitted = true;
      const result = record(await this.#client().request(
        operation.method, operation.params, REQUEST_TIMEOUT_MS,
      ));
      if (result.ok === true) return { status: "accepted" };
      this.#uncertain = true;
      return { status: "ambiguous" };
    } catch (error) {
      if (!submitted) return { status: "failed", retryable: false };
      if (error instanceof RpcRequestError) {
        const data = record(error.data);
        if (data.disposition === "may_have_completed" || data.disposition === "still_in_flight") {
          this.#uncertain = true;
          return { status: "ambiguous" };
        }
        if (data.disposition === "not_started" && data.retry_safe === true) {
          return { status: "failed", retryable: true };
        }
        if ([-32601, -32602, -32002, -32003].includes(error.code)) {
          return { status: "failed", retryable: false };
        }
      }
      this.#uncertain = true;
      return { status: "ambiguous" };
    } finally { this.#busy = false; }
  }
}
