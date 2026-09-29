import type { ProntoMessages } from "pronto-imessage";
import type {
  Channel,
  ChannelActivation,
  ChannelRecoveryOutcome,
  ChannelWatch,
  ChatAddress,
  SendDisposition,
} from "../channels/types";
import { imessageChatId } from "../storage/chat-key";
import type { CurrentChatSource } from "../tools/broker";
import { ImsgCurrentChatSource } from "./current-chat-source";
import { formatImessageReplyText, imessageReplyBodyCharacterLimit } from "./reply-format";
import { ImsgTransport } from "./transport";

export function imessageAddress(chatId: number): ChatAddress {
  return { channel: "imessage", id: String(chatId) };
}

/** Adapts the Apple Messages module to the channel interface without changing its behavior. */
export class ImessageChannel implements Channel {
  readonly kind = "imessage" as const;
  readonly conversationLabel = "iMessage or RCS";
  readonly currentChat: CurrentChatSource;
  readonly #onMessageRowId: ((rowId: number) => void | Promise<void>) | undefined;
  readonly #source: ImsgCurrentChatSource;
  readonly #transport: ImsgTransport;

  constructor(
    readonly messages: ProntoMessages,
    options: {
      matchesOutboundEcho?: (chat: ChatAddress, text: string) => boolean;
      onMessageRowId?: (rowId: number) => void | Promise<void>;
    } = {},
  ) {
    const matchesOutboundEcho = options.matchesOutboundEcho;
    this.#transport = new ImsgTransport(
      messages,
      matchesOutboundEcho === undefined
        ? {}
        : { matchesOutboundEcho: (chatId, text) => matchesOutboundEcho(imessageAddress(chatId), text) },
    );
    this.#source = new ImsgCurrentChatSource(
      messages,
      (chatId) => this.#transport.conversationContext(chatId),
    );
    this.#onMessageRowId = options.onMessageRowId;
    const source = this.#source;
    this.currentChat = {
      attachment: (chat, messageGuid, attachmentId) =>
        source.attachment(imessageChatId(chat), messageGuid, attachmentId),
      details: (chat) => source.details(imessageChatId(chat)),
      history: (chat, limit) => source.history(imessageChatId(chat), limit),
    };
  }

  async qualify(): Promise<{ degraded: readonly string[]; version: string }> {
    return await this.#transport.qualify();
  }

  async watch(input: {
    onActivation: (activation: ChannelActivation) => void | Promise<void>;
    onRecovery?: (outcome: ChannelRecoveryOutcome) => void;
    tags: () => readonly string[];
  }): Promise<ChannelWatch> {
    const onMessageRowId = this.#onMessageRowId;
    return await this.#transport.watch({
      onActivation: async (request) => {
        await input.onActivation({
          activationTag: request.activationTag,
          chat: imessageAddress(request.chatId),
          conversation: request.conversation,
          isFromMe: request.isFromMe,
          providerGuid: request.providerGuid,
          request: request.request,
        });
      },
      ...(onMessageRowId === undefined ? {} : { onMessageRowId }),
      onRecovery: (outcome) => {
        input.onRecovery?.(outcome.status === "degraded"
          ? { reason: outcome.reason, status: "degraded" }
          : { status: "recovered" });
      },
      // The transport reads `tags` for every event, so a getter keeps them current.
      get tags() {
        return input.tags();
      },
    });
  }

  formatReply(activationTag: string, text: string): string {
    return formatImessageReplyText(activationTag, text);
  }

  replyBodyCharacterLimit(activationTag: string, maxCharacters: number): number {
    return imessageReplyBodyCharacterLimit(activationTag, maxCharacters);
  }

  async recentMessages(chat: ChatAddress, limit: number, conversation?: unknown): Promise<unknown[]> {
    return await this.#transport.recentMessages(
      imessageChatId(chat),
      limit,
      conversation as Parameters<ImsgTransport["recentMessages"]>[2],
    );
  }

  async sendText(chat: ChatAddress, text: string, conversation?: unknown): Promise<SendDisposition> {
    return await this.#transport.sendText(
      imessageChatId(chat),
      text,
      conversation as Parameters<ImsgTransport["sendText"]>[2],
    );
  }

  async close(): Promise<void> {
    await this.#source.close().catch(() => undefined);
    await this.messages.close();
  }
}
