import { createHash } from "node:crypto";
import type { CurrentChatSource } from "../tools/broker";
import type {
  AttachmentReference,
  ConversationFacts,
  ConversationReference,
  MaterializedAttachment,
  MessagesEvent,
  ProntoMessages,
} from "pronto-imessage";
import { rawFromMessagesEvent } from "./event-adapter";

interface ConversationContext {
  readonly facts: ConversationFacts;
  readonly reference: ConversationReference;
}

interface ScopedAttachment {
  readonly conversation: ConversationReference;
  readonly reference: AttachmentReference;
}

function opaqueAttachmentId(reference: AttachmentReference): string {
  return createHash("sha256").update(reference.token, "utf8").digest("base64url");
}

export class ImsgCurrentChatSource implements CurrentChatSource {
  readonly #attachments = new Map<string, ScopedAttachment>();
  readonly #materialized = new Set<MaterializedAttachment>();

  constructor(
    readonly messages: ProntoMessages,
    readonly context: (chatId: number) => ConversationContext | undefined,
  ) {}

  async details(chatId: number): Promise<unknown> {
    const context = this.#context(chatId);
    return {
      owner_participated: context.facts.ownerParticipated,
      provider: context.reference.provider,
      service: context.facts.service,
    };
  }

  async history(chatId: number, limit: number): Promise<unknown> {
    const context = this.#context(chatId);
    const page = await this.messages.history({
      budget: {
        maxBytes: 2 * 1024 * 1024,
        maxMessages: Math.max(1, Math.min(limit, 50)),
        maxRows: Math.max(1, Math.min(limit, 50)),
        maxRpcCalls: 1,
      },
      conversation: context.reference,
      includeReactions: true,
      mode: "recent",
    });
    return {
      has_more: page.hasMore,
      messages: page.messages.map((event) => rawFromMessagesEvent(event, (attachment) => {
        if (attachment.reference === undefined) return undefined;
        const id = opaqueAttachmentId(attachment.reference);
        const key = `${chatId}:${event.message.providerMessageId}:${id}`;
        this.#attachments.delete(key);
        this.#attachments.set(key, {
          conversation: event.conversation,
          reference: attachment.reference,
        });
        while (this.#attachments.size > 256) {
          const oldest = this.#attachments.keys().next().value;
          if (oldest === undefined) break;
          this.#attachments.delete(oldest);
        }
        return id;
      })),
    };
  }

  async attachment(chatId: number, messageGuid: string, attachmentId: string) {
    let scoped = this.#attachments.get(`${chatId}:${messageGuid}:${attachmentId}`);
    if (scoped === undefined) {
      await this.history(chatId, 50);
      scoped = this.#attachments.get(`${chatId}:${messageGuid}:${attachmentId}`);
    }
    if (scoped === undefined) return null;
    const materialized = await this.messages.materializeAttachment({
      attachment: scoped.reference,
      conversation: scoped.conversation,
      maxBytes: 20 * 1024 * 1024,
    });
    while (this.#materialized.size >= 32) {
      const oldest = this.#materialized.values().next().value;
      if (oldest === undefined) break;
      this.#materialized.delete(oldest);
      await oldest.dispose().catch(() => undefined);
    }
    this.#materialized.add(materialized);
    return {
      attachmentId,
      messageGuid,
      name: materialized.name,
      path: materialized.path,
    };
  }

  async close(): Promise<void> {
    await Promise.all([...this.#materialized].map(async (attachment) => {
      await attachment.dispose().catch(() => undefined);
    }));
    this.#materialized.clear();
  }

  #context(chatId: number): ConversationContext {
    const context = this.context(chatId);
    if (context === undefined) throw new Error("Current conversation scope is unavailable");
    return context;
  }
}
