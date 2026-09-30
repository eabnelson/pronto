import type { CurrentChatSource } from "../tools/broker";

export const CHANNEL_KINDS = ["imessage", "whatsapp"] as const;
export type ChannelKind = (typeof CHANNEL_KINDS)[number];

export function isChannelKind(value: unknown): value is ChannelKind {
  return CHANNEL_KINDS.includes(value as ChannelKind);
}

export const CHANNEL_LABELS: Record<ChannelKind, string> = {
  imessage: "iMessage",
  whatsapp: "WhatsApp",
};

/** Identifies one conversation within one messaging app. `id` is the app's own chat id. */
export interface ChatAddress {
  readonly channel: ChannelKind;
  readonly id: string;
}

export function sameChat(left: ChatAddress, right: ChatAddress): boolean {
  return left.channel === right.channel && left.id === right.id;
}

/** Thrown by `qualify()` when the app must be linked again before it can run. */
export class ChannelNeedsLinkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChannelNeedsLinkError";
  }
}

export type SendDisposition =
  | { disposition: "confirmed"; guid: string }
  | { disposition: "ambiguous" }
  | { disposition: "failed"; retrySafe: boolean };

/** A tagged request that passed the channel's activation rules. */
export interface ChannelActivation {
  readonly activationTag: string;
  readonly chat: ChatAddress;
  /** Channel-owned, JSON-serializable scope needed to reply after a restart. */
  readonly conversation?: unknown;
  readonly isFromMe: boolean;
  readonly providerGuid: string;
  readonly request: string;
}

/** What a turn needs from the channel that the request arrived on. */
export interface TurnChannel {
  /** Describes the conversation to the runtime, e.g. "iMessage or RCS". */
  readonly conversationLabel: string;
  formatReply(activationTag: string, text: string): string;
  replyBodyCharacterLimit(activationTag: string, maxCharacters: number): number;
  recentMessages(chat: ChatAddress, limit: number, conversation?: unknown): Promise<unknown[]>;
  sendText(chat: ChatAddress, text: string, conversation?: unknown): Promise<SendDisposition>;
  /** Best-effort typing indicator while a turn runs; never throws. */
  setTyping?(chat: ChatAddress, conversation: unknown, typing: boolean): Promise<void>;
}

export interface ChannelWatch {
  close(): Promise<void>;
  /** Settles when the channel stops delivering events without being closed. */
  readonly terminated: Promise<void>;
}

export type ChannelRecoveryOutcome =
  | { readonly status: "recovered" }
  | { readonly reason: string; readonly status: "degraded" };

/** Connection state a channel reports on its own, beyond recovery outcomes. */
export type ChannelConnectionHealth =
  | { readonly state: "connected" }
  | { readonly reason: string; readonly state: "reconnecting" }
  | { readonly state: "needs_link" };

export interface Channel extends TurnChannel {
  readonly kind: ChannelKind;
  readonly currentChat: CurrentChatSource;
  qualify(): Promise<{ degraded: readonly string[]; version: string }>;
  watch(input: {
    onActivation: (activation: ChannelActivation) => void | Promise<void>;
    onHealth?: (health: ChannelConnectionHealth) => void;
    onRecovery?: (outcome: ChannelRecoveryOutcome) => void;
    /** Read on every message, so tag changes apply without restarting the watch. */
    tags: () => readonly string[];
  }): Promise<ChannelWatch>;
  close(): Promise<void>;
}
