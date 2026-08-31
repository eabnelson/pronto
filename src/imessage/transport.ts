import { createHash } from "node:crypto";
import { activatedRequest, type ActivatedRequest } from "../activation";
import { normalizeMessage, type NormalizedMessage } from "./message";
import { qualifyImsgStatus, type QualifiedImsg } from "./probe";
import { ImsgRpcError, type ImsgRpc, type WatchableImsgRpc } from "./rpc-client";

export type SendDisposition =
  | { disposition: "confirmed"; guid: string }
  | { disposition: "ambiguous" }
  | { disposition: "failed"; retrySafe: boolean };

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

interface ChatEligibility {
  ownerParticipated: boolean;
  service: string | null;
}

function messageDateMs(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isMirrorPair(message: NormalizedMessage, original: NormalizedMessage): boolean {
  if (
    message.chatId === null ||
    message.rowId === null ||
    message.text === null ||
    original.chatId !== message.chatId ||
    original.rowId === null ||
    !original.isFromMe ||
    original.text !== message.text
  ) {
    return false;
  }
  const rowDistance = message.rowId - original.rowId;
  if (rowDistance < 1) return false;
  const messageTime = messageDateMs(message.date);
  const originalTime = messageDateMs(original.date);
  return (
    messageTime !== null &&
    originalTime !== null &&
    messageTime <= originalTime &&
    originalTime - messageTime <= 1_000
  );
}

function isCorrelatedMirror(message: NormalizedMessage, original: NormalizedMessage): boolean {
  return (
    message.replyToGuid !== null &&
    message.replyToText === message.text &&
    original.providerGuid === message.replyToGuid &&
    isMirrorPair(message, original)
  );
}

export class ImsgTransport {
  readonly #recentOutgoing = new Map<string, NormalizedMessage>();

  constructor(
    readonly rpc: ImsgRpc,
    readonly options: {
      matchesOutboundEcho?: (chatId: number, text: string) => boolean;
    } = {},
  ) {}

  async qualify(): Promise<QualifiedImsg> {
    const status = await this.rpc.call("initialize", { protocol_version: 1 });
    return qualifyImsgStatus(status);
  }

  async ownerParticipated(chatId: number): Promise<boolean> {
    return (await this.#chatEligibility(chatId)).ownerParticipated;
  }

  async #chatEligibility(chatId: number): Promise<ChatEligibility> {
    const result = object(await this.rpc.call("messages.stats", { chat_id: chatId }));
    const chat = (Array.isArray(result.chats) ? result.chats : [])
      .map(object)
      .find((candidate) => candidate.chat_id === chatId);
    return {
      ownerParticipated:
        typeof result.sent_messages === "number" && result.sent_messages > 0,
      service: chat !== undefined && typeof chat.service === "string" ? chat.service : null,
    };
  }

  async activationFor(raw: unknown, tags: readonly string[]): Promise<ActivatedRequest | null> {
    return this.#activationForMessage(normalizeMessage(raw), tags);
  }

  async #activationForMessage(
    message: NormalizedMessage,
    tags: readonly string[],
  ): Promise<ActivatedRequest | null> {
    this.#rememberOutgoing(message);
    if (
      message.isFromMe &&
      message.chatId !== null &&
      message.text !== null &&
      this.options.matchesOutboundEcho?.(message.chatId, message.text) === true
    ) {
      return null;
    }
    let candidate = activatedRequest(message, tags, true);
    let eligibility: ChatEligibility | null = null;
    if (candidate === null && message.service === null) {
      const potentialCandidate = activatedRequest({ ...message, service: "iMessage" }, tags, true);
      if (potentialCandidate === null) return null;
      eligibility = await this.#chatEligibility(potentialCandidate.chatId);
      if (
        !eligibility.ownerParticipated ||
        eligibility.service?.toLowerCase() !== "imessage"
      ) {
        return null;
      }
      candidate = potentialCandidate;
    }
    if (candidate === null) return null;
    eligibility ??= await this.#chatEligibility(candidate.chatId);
    if (!eligibility.ownerParticipated) return null;
    if (await this.#isSelfChatMirror(message)) return null;
    return candidate;
  }

  async #isSelfChatMirror(message: NormalizedMessage): Promise<boolean> {
    if (
      message.isFromMe ||
      message.chatId === null ||
      message.rowId === null ||
      message.text === null
    ) {
      return false;
    }
    for (const cached of this.#recentOutgoing.values()) {
      if (isMirrorPair(message, cached)) return true;
    }
    const hasReplyLink = message.replyToGuid !== null && message.replyToText === message.text;
    try {
      const nearby = await this.#messagesNear(message.rowId);
      return nearby.some((raw) => {
        const original = normalizeMessage(raw);
        return hasReplyLink
          ? isCorrelatedMirror(message, original)
          : isMirrorPair(message, original);
      });
    } catch {
      if (!hasReplyLink) return false;
      // Re-running an unrestricted agent is riskier than dropping this narrowly
      // mirror-shaped event when restart-boundary correlation is unavailable.
      console.error(
        JSON.stringify({ component: "imsg-transport", state: "mirror-correlation-unavailable" }),
      );
      return true;
    }
  }

  async #messagesNear(rowId: number): Promise<unknown[]> {
    const result = object(
      await this.rpc.call("messages.after", {
        attachments: false,
        include_reactions: true,
        limit: 100,
        since_rowid: Math.max(0, rowId - 101),
      }),
    );
    return Array.isArray(result.messages) ? result.messages : [];
  }

  #outgoingKey(chatId: number, guid: string): string {
    return `${chatId}:${guid}`;
  }

  #rememberOutgoing(message: NormalizedMessage): void {
    if (!message.isFromMe || message.chatId === null || message.providerGuid === null) return;
    const key = this.#outgoingKey(message.chatId, message.providerGuid);
    this.#recentOutgoing.delete(key);
    this.#recentOutgoing.set(key, message);
    while (this.#recentOutgoing.size > 64) {
      const oldest = this.#recentOutgoing.keys().next().value;
      if (oldest === undefined) break;
      this.#recentOutgoing.delete(oldest);
    }
  }

  async recentMessages(chatId: number, limit = 30): Promise<unknown[]> {
    const result = object(
      await this.rpc.call("messages.history", {
        attachments: true,
        chat_id: chatId,
        limit: Math.max(1, Math.min(limit, 100)),
      }),
    );
    return Array.isArray(result.messages) ? result.messages : [];
  }

  async watch(input: {
    onActivation: (request: ActivatedRequest) => void | Promise<void>;
    onMessageRowId?: (rowId: number) => void | Promise<void>;
    onOverflow: (resumeAfterRowId: number) => void | Promise<void>;
    sinceRowId?: number;
    tags: readonly string[];
  }): Promise<{ close: () => Promise<void>; terminated: Promise<void> }> {
    if (!("on" in this.rpc) || typeof this.rpc.on !== "function") {
      throw new Error("imsg RPC client does not support notifications");
    }
    const rpc = this.rpc as WatchableImsgRpc;
    let subscription: number | null = null;
    const disposeMessage = rpc.on("message", async (params) => {
      const notification = object(params);
      if (notification.subscription !== subscription) return;
      const message = normalizeMessage(notification.message);
      const request = await this.#activationForMessage(message, input.tags);
      if (request !== null) await input.onActivation(request);
      if (message.rowId !== null) await input.onMessageRowId?.(message.rowId);
    });
    const disposeOverflow = rpc.on("watch.overflow", async (params) => {
      const notification = object(params);
      if (notification.subscription !== subscription) return;
      if (
        notification.terminal === true &&
        typeof notification.resume_after_rowid === "number" &&
        Number.isSafeInteger(notification.resume_after_rowid)
      ) {
        await input.onOverflow(notification.resume_after_rowid);
      }
    });

    try {
      const result = object(
        await rpc.call("watch.subscribe", {
          attachments: true,
          buffer_limit: 256,
          include_reactions: true,
          ...(input.sinceRowId === undefined ? {} : { since_rowid: input.sinceRowId }),
        }),
      );
      if (typeof result.subscription !== "number") {
        throw new Error("imsg returned an invalid watch subscription");
      }
      subscription = result.subscription;
      return {
        close: async () => {
          const active = subscription;
          subscription = null;
          disposeMessage();
          disposeOverflow();
          if (active !== null) await rpc.call("watch.unsubscribe", { subscription: active });
        },
        terminated:
          "terminated" in rpc && rpc.terminated instanceof Promise
            ? (rpc.terminated as Promise<void>)
            : new Promise<void>(() => undefined),
      };
    } catch (error) {
      disposeMessage();
      disposeOverflow();
      throw error;
    }
  }

  async catchUp(input: {
    onActivation: (request: ActivatedRequest) => void | Promise<void>;
    onMessageRowId?: (rowId: number) => void | Promise<void>;
    sinceRowId: number;
    tags: readonly string[];
  }): Promise<number> {
    let cursor = input.sinceRowId;
    while (true) {
      const previousCursor = cursor;
      const result = object(
        await this.rpc.call("messages.after", {
          attachments: true,
          include_reactions: true,
          limit: 100,
          since_rowid: cursor,
        }),
      );
      const next = result.next_rowid;
      if (typeof next !== "number" || !Number.isSafeInteger(next) || next < cursor) {
        throw new Error("imsg returned an invalid catch-up cursor");
      }
      for (const raw of Array.isArray(result.messages) ? result.messages : []) {
        const message = normalizeMessage(raw);
        const request = await this.#activationForMessage(message, input.tags);
        if (request !== null) await input.onActivation(request);
        if (message.rowId !== null) await input.onMessageRowId?.(message.rowId);
      }
      cursor = next;
      if (result.has_more !== true) return cursor;
      if (next === previousCursor) throw new Error("imsg catch-up cursor did not advance");
    }
  }

  async sendText(chatId: number, text: string): Promise<SendDisposition> {
    try {
      const result = object(await this.rpc.call("send", { chat_id: chatId, text }));
      if (result.ok !== true) return { disposition: "failed", retrySafe: false };
      return typeof result.guid === "string" && result.guid.length > 0
        ? { disposition: "confirmed", guid: result.guid }
        : { disposition: "ambiguous" };
    } catch (error) {
      if (error instanceof ImsgRpcError) {
        const data = object(error.data);
        if (data.disposition === "may_have_completed" || data.disposition === "still_in_flight") {
          return { disposition: "ambiguous" };
        }
        return { disposition: "failed", retrySafe: data.retry_safe === true };
      }
      return { disposition: "failed", retrySafe: false };
    }
  }
}

interface FingerprintEntry {
  expiresAt: number;
  value: string;
}

export class OutboundEchoTracker {
  readonly #entries: FingerprintEntry[] = [];
  readonly #maxEntries: number;
  readonly #now: () => number;
  readonly #ttlMs: number;

  constructor(input: { maxEntries?: number; now?: () => number; ttlMs?: number } = {}) {
    this.#maxEntries = input.maxEntries ?? 256;
    this.#now = input.now ?? Date.now;
    this.#ttlMs = input.ttlMs ?? 24 * 60 * 60 * 1_000;
  }

  record(chatId: number, text: string): void {
    this.#prune();
    this.#entries.push({ expiresAt: this.#now() + this.#ttlMs, value: this.#hash(chatId, text) });
    while (this.#entries.length > this.#maxEntries) this.#entries.shift();
  }

  matches(chatId: number, text: string): boolean {
    this.#prune();
    const value = this.#hash(chatId, text);
    const index = this.#entries.findIndex((entry) => entry.value === value);
    if (index < 0) return false;
    this.#entries.splice(index, 1);
    return true;
  }

  #hash(chatId: number, text: string): string {
    return createHash("sha256").update(`${chatId}\0${text}`).digest("base64url");
  }

  #prune(): void {
    const now = this.#now();
    for (let index = this.#entries.length - 1; index >= 0; index--) {
      if (this.#entries[index]!.expiresAt <= now) this.#entries.splice(index, 1);
    }
  }
}
