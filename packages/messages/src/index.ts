import { ImsgRpcClient, RpcRequestError, type RpcNotification } from "./internal/rpc.js";
import {
  normalizeConversationFacts,
  normalizeEvent,
  qualify,
  record,
} from "./internal/normalize.js";
import type {
  DeliveryOutcome,
  MessagesEvent,
  MessagesQualification,
  MessagesSubscription,
  ProntoMessages,
} from "./types.js";

export type {
  ConversationFacts,
  ConversationReference,
  DeliveryOutcome,
  MessagesAttachment,
  MessagesEvent,
  MessagesQualification,
  MessagesSubscription,
  ProntoMessages,
} from "./types.js";

function messageDateMs(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isMirrorPair(message: MessagesEvent, original: MessagesEvent): boolean {
  if (
    original.conversation.chatId !== message.conversation.chatId ||
    !original.message.fromMe ||
    original.message.text !== message.message.text
  ) {
    return false;
  }
  const rowDistance = message.message.rowId - original.message.rowId;
  if (rowDistance < 1) return false;
  const messageTime = messageDateMs(message.message.occurredAt);
  const originalTime = messageDateMs(original.message.occurredAt);
  return (
    messageTime !== null &&
    originalTime !== null &&
    messageTime <= originalTime &&
    originalTime - messageTime <= 1_000
  );
}

class ProntoMessagesClient implements ProntoMessages {
  readonly #rpc: ImsgRpcClient;
  readonly #recentOutgoing = new Map<string, MessagesEvent>();

  constructor(imsgPath: string) {
    this.#rpc = new ImsgRpcClient(imsgPath);
  }

  async qualify(): Promise<MessagesQualification> {
    return qualify(await this.#rpc.request("initialize", { protocol_version: 1 }, 10_000));
  }

  async subscribe(
    input: Parameters<ProntoMessages["subscribe"]>[0],
  ): Promise<MessagesSubscription> {
    let subscriptionId: number | null = null;
    const pendingNotifications: RpcNotification[] = [];
    const handleNotification = (notification: RpcNotification) => {
      const params = record(notification.params);
      if (params.subscription !== subscriptionId) return;
      if (notification.method === "watch.overflow") {
        if (
          params.terminal === true &&
          typeof params.resume_after_rowid === "number" &&
          Number.isSafeInteger(params.resume_after_rowid)
        ) {
          void Promise.resolve(input.onOverflow?.(params.resume_after_rowid)).catch(() => undefined);
        }
        return;
      }
      if (notification.method !== "message") return;
      const rawMessage = record(params.message);
      const chatId = rawMessage.chat_id;
      if (typeof chatId !== "number" || !Number.isSafeInteger(chatId) || chatId <= 0) return;
      void this.#rpc.request("messages.stats", { chat_id: chatId })
        .then(async (stats) => {
          const event = normalizeEvent(rawMessage, normalizeConversationFacts(stats, chatId));
          if (event === null) return;
          const normalizedEvent: MessagesEvent = {
            ...event,
            message: {
              ...event.message,
              selfChatMirror: await this.#isSelfChatMirror(event),
            },
          };
          this.#rememberOutgoing(normalizedEvent);
          return input.onEvent(normalizedEvent);
        })
        .catch(() => undefined);
    };
    const dispose = this.#rpc.onNotification((notification) => {
      if (subscriptionId === null) {
        pendingNotifications.push(notification);
        return;
      }
      handleNotification(notification);
    });
    try {
      const result = record(await this.#rpc.request("watch.subscribe", {
        attachments: true,
        buffer_limit: 256,
        include_reactions: true,
        ...(input.sinceRowId === undefined ? {} : { since_rowid: input.sinceRowId }),
      }));
      if (typeof result.subscription !== "number" || !Number.isSafeInteger(result.subscription)) {
        throw new Error("imsg returned an invalid watch subscription");
      }
      subscriptionId = result.subscription;
      for (const notification of pendingNotifications.splice(0)) {
        handleNotification(notification);
      }
      return {
        close: async () => {
          const active = subscriptionId;
          subscriptionId = null;
          dispose();
          if (active !== null) {
            await this.#rpc.request("watch.unsubscribe", { subscription: active });
          }
        },
        terminated: this.#rpc.terminated,
      };
    } catch (error) {
      dispose();
      throw error;
    }
  }

  async reply(input: Parameters<ProntoMessages["reply"]>[0]): Promise<DeliveryOutcome> {
    try {
      const result = record(await this.#rpc.request("send", {
        chat_id: input.conversation.chatId,
        text: input.text,
      }));
      if (result.ok !== true) return { retryable: false, status: "failed" };
      return typeof result.guid === "string" && result.guid !== ""
        ? { providerMessageId: result.guid, status: "confirmed" }
        : { status: "ambiguous" };
    } catch (error) {
      if (!(error instanceof RpcRequestError)) return { retryable: false, status: "failed" };
      const data = record(error.data);
      return data.disposition === "may_have_completed" || data.disposition === "still_in_flight"
        ? { status: "ambiguous" }
        : { retryable: data.retry_safe === true, status: "failed" };
    }
  }

  async #isSelfChatMirror(event: MessagesEvent): Promise<boolean> {
    if (event.message.fromMe || event.message.text === null) return false;
    for (const outgoing of this.#recentOutgoing.values()) {
      if (isMirrorPair(event, outgoing)) return true;
    }
    const hasReplyLink =
      event.message.replyToProviderMessageId !== null &&
      event.message.replyToText === event.message.text;
    try {
      const result = record(await this.#rpc.request("messages.after", {
        attachments: false,
        include_reactions: true,
        limit: 100,
        since_rowid: Math.max(0, event.message.rowId - 101),
      }));
      for (const raw of Array.isArray(result.messages) ? result.messages : []) {
        const original = normalizeEvent(raw, event.conversationFacts);
        if (original === null) continue;
        if (
          hasReplyLink
            ? original.message.providerMessageId === event.message.replyToProviderMessageId &&
              isMirrorPair(event, original)
            : isMirrorPair(event, original)
        ) {
          return true;
        }
      }
      return false;
    } catch {
      return hasReplyLink;
    }
  }

  #rememberOutgoing(event: MessagesEvent): void {
    if (!event.message.fromMe) return;
    const key = `${event.conversation.chatId}:${event.message.providerMessageId}`;
    this.#recentOutgoing.delete(key);
    this.#recentOutgoing.set(key, event);
    while (this.#recentOutgoing.size > 64) {
      const oldest = this.#recentOutgoing.keys().next().value;
      if (oldest === undefined) return;
      this.#recentOutgoing.delete(oldest);
    }
  }

  close(): Promise<void> {
    return this.#rpc.close();
  }
}

export function createProntoMessages(input: { readonly imsgPath: string }): ProntoMessages {
  return new ProntoMessagesClient(input.imsgPath);
}
