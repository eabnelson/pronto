import { createHash } from "node:crypto";
import {
  WhatsappAttachmentExpiredError,
  type MaterializedWhatsappAttachment,
  type ProntoWhatsapp,
  type WhatsappConversationReference,
  type WhatsappEvent,
  type WhatsappSubscription,
} from "pronto-whatsapp";
import { removeOneMatchedTag } from "../activation";
import {
  ChannelNeedsLinkError,
  type Channel,
  type ChannelActivation,
  type ChannelConnectionHealth,
  type ChannelRecoveryOutcome,
  type ChannelWatch,
  type ChatAddress,
  type OutboundAttachment,
  type SendDisposition,
} from "../channels/types";
import type { CurrentChatMessage } from "../imessage/event-adapter";
import type { CurrentChatSource } from "../tools/broker";
import { formatWhatsappReplyText, whatsappReplyBodyCharacterLimit } from "./reply-format";

interface ObservedConversation {
  readonly event: WhatsappEvent;
  readonly reference: WhatsappConversationReference;
}

/** The reply scope Pronto stores for a WhatsApp turn: the module's reference plus the message to quote. */
export interface WhatsappTurnConversation extends WhatsappConversationReference {
  readonly quote?: { readonly providerMessageId: string; readonly sender: string | null };
}

export function whatsappAddress(chatJid: string): ChatAddress {
  return { channel: "whatsapp", id: chatJid };
}

/**
 * Applies the same activation rules as iMessage: the owner must have taken part in the chat,
 * only ordinary text messages count, exactly one configured tag must match, and Pronto's own
 * sends never activate. Age limits are enforced by `pronto-whatsapp` with iMessage's defaults.
 */
export function whatsappActivation(
  event: WhatsappEvent,
  tags: readonly string[],
): ChannelActivation | null {
  const message = event.message;
  if (!event.conversationFacts.ownerParticipated) return null;
  if (message.kind !== "message" || message.text === null) return null;
  const activation = removeOneMatchedTag(message.text, tags);
  if (activation === null) return null;
  const conversation: WhatsappTurnConversation = {
    ...event.conversation,
    quote: { providerMessageId: message.providerMessageId, sender: message.sender },
  };
  return {
    activationTag: activation.activationTag,
    chat: whatsappAddress(event.conversation.chatJid),
    conversation,
    isFromMe: message.fromMe,
    providerGuid: `whatsapp:${event.conversation.chatJid}:${message.providerMessageId}`,
    request: activation.request,
  };
}

const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const MAX_MATERIALIZED_ATTACHMENTS = 32;
export const ACKNOWLEDGMENT_EMOJI = "👀";
export const EXPIRED_ATTACHMENT_MESSAGE =
  "attachment-expired: WhatsApp no longer has this media on its servers. Ask the sender to send it again.";

/** Opaque per-chat attachment id: WhatsApp messages carry at most one media item. */
export function whatsappAttachmentId(chatJid: string, messageId: string): string {
  return createHash("sha256").update(`${chatJid}\0${messageId}`).digest("base64url").slice(0, 32);
}

function currentChatMessage(event: WhatsappEvent): CurrentChatMessage {
  const media = event.message.media;
  return {
    attachments: media === null
      ? []
      : [{
        attachmentId: whatsappAttachmentId(event.conversation.chatJid, event.message.providerMessageId),
        available: true,
        mimeType: media.mimeType,
        name: media.filename ?? `${media.type} attachment`,
        sizeBytes: media.sizeBytes,
      }],
    fromMe: event.message.fromMe,
    kind: event.message.kind === "poll" ? "poll" : "message",
    messageGuid: event.message.providerMessageId,
    occurredAt: event.message.occurredAt,
    reaction: null,
    sender: event.message.fromMe ? null : event.message.sender,
    service: "WhatsApp",
    text: event.message.text,
    urlPreview: false,
  };
}

function reference(conversation: unknown): WhatsappConversationReference | undefined {
  if (conversation === null || typeof conversation !== "object") return undefined;
  const value = conversation as WhatsappTurnConversation;
  return {
    chatJid: value.chatJid,
    expiresAt: value.expiresAt,
    provider: value.provider,
    token: value.token,
    version: value.version,
  };
}

export class WhatsappChannel implements Channel {
  readonly kind = "whatsapp" as const;
  readonly conversationLabel = "WhatsApp";
  readonly maxAttachmentBytes = MAX_ATTACHMENT_BYTES;
  readonly currentChat: CurrentChatSource;
  readonly #conversations = new Map<string, ObservedConversation>();
  readonly #materialized = new Set<MaterializedWhatsappAttachment>();

  constructor(
    readonly whatsapp: ProntoWhatsapp,
    readonly options: {
      /** React with 👀 to the tagged message when its turn starts. */
      acknowledge?: boolean;
      matchesOutboundEcho?: (chat: ChatAddress, text: string) => boolean;
    } = {},
  ) {
    this.currentChat = {
      attachment: async (chat, messageGuid, attachmentId) => {
        const observed = this.#observed(chat);
        if (attachmentId !== whatsappAttachmentId(chat.id, messageGuid)) return null;
        const materialized = await this.whatsapp.materializeAttachment({
          conversation: observed.reference,
          maxBytes: MAX_ATTACHMENT_BYTES,
          providerMessageId: messageGuid,
        }).catch((error: unknown) => {
          throw error instanceof WhatsappAttachmentExpiredError
            ? new Error(EXPIRED_ATTACHMENT_MESSAGE)
            : error;
        });
        while (this.#materialized.size >= MAX_MATERIALIZED_ATTACHMENTS) {
          const oldest = this.#materialized.values().next().value;
          if (oldest === undefined) break;
          this.#materialized.delete(oldest);
          await oldest.dispose().catch(() => undefined);
        }
        this.#materialized.add(materialized);
        return { attachmentId, messageGuid, name: materialized.name, path: materialized.path };
      },
      details: async (chat) => {
        const observed = this.#observed(chat);
        return {
          is_group: observed.event.conversationFacts.isGroup,
          owner_participated: observed.event.conversationFacts.ownerParticipated,
          provider: "whatsapp",
          self_chat: observed.event.conversationFacts.selfChat,
        };
      },
      history: async (chat, limit) => {
        const observed = this.#observed(chat);
        const events = await this.whatsapp.history({
          conversation: observed.reference,
          limit: Math.max(1, Math.min(limit, 50)),
        });
        return { has_more: events.length >= limit, messages: events.map(currentChatMessage) };
      },
    };
  }

  async qualify(): Promise<{ degraded: readonly string[]; version: string }> {
    const qualification = await this.whatsapp.qualify();
    if (qualification.status === "needs_link") {
      throw new ChannelNeedsLinkError("WhatsApp is not linked; run pronto whatsapp link");
    }
    return { degraded: [], version: qualification.wacliVersion };
  }

  activationFor(event: WhatsappEvent, tags: readonly string[]): ChannelActivation | null {
    this.#conversations.set(event.conversation.chatJid, { event, reference: event.conversation });
    const text = event.message.text;
    if (
      event.message.fromMe && text !== null &&
      this.options.matchesOutboundEcho?.(whatsappAddress(event.conversation.chatJid), text) === true
    ) return null;
    return whatsappActivation(event, tags);
  }

  async watch(input: {
    onActivation: (activation: ChannelActivation) => void | Promise<void>;
    onHealth?: (health: ChannelConnectionHealth) => void;
    onRecovery?: (outcome: ChannelRecoveryOutcome) => void;
    tags: () => readonly string[];
  }): Promise<ChannelWatch> {
    const subscription: WhatsappSubscription = await this.whatsapp.subscribe({
      onEvent: async (event) => {
        const activation = this.activationFor(event, input.tags());
        if (activation !== null) await input.onActivation(activation);
      },
      onHealth: (health) => {
        if (health.state === "connected") input.onHealth?.({ state: "connected" });
        else if (health.state === "needs_link") input.onHealth?.({ state: "needs_link" });
        else if (health.state === "reconnecting" || health.state === "failed") {
          input.onHealth?.({ reason: health.reason, state: "reconnecting" });
        }
      },
      onRecovery: (outcome) => {
        input.onRecovery?.(outcome.status === "degraded"
          ? { reason: `whatsapp-${outcome.reason}`, status: "degraded" }
          : { status: "recovered" });
      },
    });
    // The subscription ends on its own only when WhatsApp unlinks the device. Restarting
    // Pronto cannot fix that, so report it and keep the listener running for other apps.
    let closed = false;
    void subscription.terminated.then(() => {
      if (!closed) input.onHealth?.({ state: "needs_link" });
    });
    return {
      close: async () => {
        closed = true;
        await subscription.close();
      },
      terminated: new Promise<void>(() => undefined),
    };
  }

  formatReply(activationTag: string, text: string): string {
    return formatWhatsappReplyText(activationTag, text);
  }

  replyBodyCharacterLimit(activationTag: string, maxCharacters: number): number {
    return whatsappReplyBodyCharacterLimit(activationTag, maxCharacters);
  }

  async recentMessages(chat: ChatAddress, limit: number, conversation?: unknown): Promise<unknown[]> {
    const scope = this.#conversations.get(chat.id)?.reference ?? reference(conversation);
    if (scope === undefined || scope.chatJid !== chat.id) {
      throw new Error("Current conversation scope is unavailable");
    }
    const events = await this.whatsapp.history({ conversation: scope, limit: Math.max(1, Math.min(limit, 100)) });
    return events.map(currentChatMessage);
  }

  async sendText(
    chat: ChatAddress,
    text: string,
    conversation?: unknown,
    attachment?: OutboundAttachment,
  ): Promise<SendDisposition> {
    const scope = reference(conversation) ?? this.#conversations.get(chat.id)?.reference;
    if (scope === undefined || scope.chatJid !== chat.id) {
      throw new Error("Current conversation scope is unavailable");
    }
    const quote = (conversation as WhatsappTurnConversation | undefined)?.quote;
    const outcome = await this.whatsapp.reply({
      conversation: scope,
      ...(attachment === undefined ? {} : { filePath: attachment.filePath }),
      ...(quote === undefined ? {} : { quote }),
      text,
    });
    if (outcome.status === "confirmed") {
      return { disposition: "confirmed", guid: outcome.providerMessageId };
    }
    if (outcome.status === "ambiguous") return { disposition: "ambiguous" };
    return { disposition: "failed", retrySafe: outcome.retryable };
  }

  async acknowledge(chat: ChatAddress, conversation: unknown): Promise<void> {
    if (this.options.acknowledge !== true) return;
    const scope = reference(conversation);
    const quote = (conversation as WhatsappTurnConversation | undefined)?.quote;
    if (scope === undefined || scope.chatJid !== chat.id || quote === undefined) return;
    await this.whatsapp.react({
      conversation: scope,
      emoji: ACKNOWLEDGMENT_EMOJI,
      providerMessageId: quote.providerMessageId,
      sender: quote.sender,
    }).catch(() => undefined);
  }

  async setTyping(chat: ChatAddress, conversation: unknown, typing: boolean): Promise<void> {
    const scope = reference(conversation) ?? this.#conversations.get(chat.id)?.reference;
    if (scope === undefined || scope.chatJid !== chat.id) return;
    await this.whatsapp.presence?.setTyping(scope, typing).catch(() => undefined);
  }

  async close(): Promise<void> {
    await Promise.all([...this.#materialized].map(async (attachment) => {
      await attachment.dispose().catch(() => undefined);
    }));
    this.#materialized.clear();
    await this.whatsapp.close();
  }

  #observed(chat: ChatAddress): ObservedConversation {
    const observed = this.#conversations.get(chat.id);
    if (chat.channel !== "whatsapp" || observed === undefined) {
      throw new Error("Current conversation scope is unavailable");
    }
    return observed;
  }
}
