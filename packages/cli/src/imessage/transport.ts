import { activatedRequest, type ActivatedRequest } from "../activation";
import type {
  ConversationFacts,
  ConversationReference,
  MessagesEvent,
  MessagesSubscription,
  ProntoMessages,
} from "pronto-imessage";
import { currentChatMessageFromEvent } from "./event-adapter";

export type SendDisposition =
  | { disposition: "confirmed"; guid: string }
  | { disposition: "ambiguous" }
  | { disposition: "failed"; retrySafe: boolean };

interface ConversationContext {
  readonly facts: ConversationFacts;
  readonly reference: ConversationReference;
}

export class ImsgTransport {
  readonly #conversations = new Map<number, ConversationContext>();

  constructor(
    readonly messages: ProntoMessages,
    readonly options: {
      matchesOutboundEcho?: (chatId: number, text: string) => boolean;
    } = {},
  ) {}

  async qualify(): Promise<{ degraded: readonly string[]; version: string }> {
    const qualification = await this.messages.qualify();
    return {
      degraded: qualification.degradedCapabilities,
      version: qualification.providerVersion,
    };
  }

  conversationContext(chatId: number): ConversationContext | undefined {
    return this.#conversations.get(chatId);
  }

  activationFor(event: MessagesEvent, tags: readonly string[]): ActivatedRequest | null {
    this.#conversations.set(event.conversation.chatId, {
      facts: event.conversationFacts,
      reference: event.conversation,
    });
    if (
      event.message.fromMe && event.message.text !== null &&
      this.options.matchesOutboundEcho?.(event.conversation.chatId, event.message.text) === true
    ) return null;
    return activatedRequest(event, tags);
  }

  async recentMessages(
    chatId: number,
    limit = 30,
    restoredConversation?: ConversationReference,
  ): Promise<unknown[]> {
    const conversation = this.#conversations.get(chatId)?.reference ?? restoredConversation;
    if (conversation === undefined) throw new Error("Current conversation scope is unavailable");
    const page = await this.messages.history({
      budget: {
        maxBytes: 2 * 1024 * 1024,
        maxMessages: Math.max(1, Math.min(limit, 100)),
        maxRows: Math.max(1, Math.min(limit, 100)),
        maxRpcCalls: 1,
      },
      conversation,
      includeReactions: true,
      mode: "recent",
    });
    return page.messages.map((event) => currentChatMessageFromEvent(event));
  }

  async watch(input: {
    onActivation: (request: ActivatedRequest) => void | Promise<void>;
    onMessageRowId?: (rowId: number) => void | Promise<void>;
    tags: readonly string[];
  }): Promise<MessagesSubscription> {
    return await this.messages.subscribe({
      onEvent: async (event) => {
        const request = this.activationFor(event, input.tags);
        if (request !== null) await input.onActivation(request);
        await input.onMessageRowId?.(event.message.rowId);
      },
      onRecovery: (outcome) => {
        console.error(JSON.stringify({
          component: "pronto-messages",
          ...(outcome.status === "degraded" ? { reason: outcome.reason } : {}),
          rows: outcome.rows,
          state: outcome.status,
        }));
      },
    });
  }

  async sendText(
    chatId: number,
    text: string,
    restoredConversation?: ConversationReference,
  ): Promise<SendDisposition> {
    const conversation = this.#conversations.get(chatId)?.reference ?? restoredConversation;
    if (conversation === undefined) throw new Error("Current conversation scope is unavailable");
    if (conversation.chatId !== chatId) throw new Error("Current conversation scope is unavailable");
    const outcome = await this.messages.reply({ conversation, text });
    if (outcome.status === "confirmed") {
      return { disposition: "confirmed", guid: outcome.providerMessageId };
    }
    if (outcome.status === "ambiguous") return { disposition: "ambiguous" };
    return { disposition: "failed", retrySafe: outcome.retryable };
  }
}
