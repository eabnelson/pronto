export const WHATSAPP_PROVIDER = "whatsapp" as const;

/** Oldest wacli release whose sync webhook, delegated send, and JSON output this module relies on. */
export const MINIMUM_WACLI_VERSION = "0.19.0";

/**
 * Opaque, expiring proof that the consumer observed this conversation through the module.
 * Safe to persist; only the module that issued it (same `referenceKey`) accepts it.
 */
export interface WhatsappConversationReference {
  /** Canonical chat JID: `<phone>@s.whatsapp.net` for direct chats, `<id>@g.us` for groups. */
  readonly chatJid: string;
  readonly expiresAt: string;
  readonly provider: typeof WHATSAPP_PROVIDER;
  readonly token: string;
  readonly version: 1;
}

export interface WhatsappConversationFacts {
  readonly isGroup: boolean;
  /** The linked account has sent at least one message in this chat. */
  readonly ownerParticipated: boolean;
  /** The chat is the linked account's own "Message yourself" chat. */
  readonly selfChat: boolean;
}

export type WhatsappMessageKind =
  | "message"
  | "reaction"
  | "edit"
  | "revoke"
  | "poll"
  | "call"
  | "unsupported";

export interface WhatsappMedia {
  readonly caption: string | null;
  readonly filename: string | null;
  readonly mimeType: string | null;
  /** Declared size when WhatsApp reported it (live messages); null for recovered rows. */
  readonly sizeBytes: number | null;
  readonly type: string;
}

/** A private copy of one message's media. Call `dispose()` when finished with it. */
export interface MaterializedWhatsappAttachment {
  dispose(): Promise<void>;
  readonly mimeType: string;
  readonly name: string;
  readonly path: string;
  readonly sha256: string;
  readonly sizeBytes: number;
}

export interface WhatsappMessage {
  readonly fromMe: boolean;
  readonly kind: WhatsappMessageKind;
  readonly media: WhatsappMedia | null;
  readonly occurredAt: string;
  readonly providerMessageId: string;
  readonly replyToProviderMessageId: string | null;
  /** Canonical sender JID; the linked account for `fromMe` messages. */
  readonly sender: string | null;
  readonly senderName: string | null;
  /** Message text, or the media caption when the message is captioned media. */
  readonly text: string | null;
}

export interface WhatsappEvent {
  readonly conversation: WhatsappConversationReference;
  readonly conversationFacts: WhatsappConversationFacts;
  readonly message: WhatsappMessage;
  /** `live` arrived through the sync webhook; `recovered` came from a catch-up sweep. */
  readonly origin: "live" | "recovered";
  readonly provider: typeof WHATSAPP_PROVIDER;
  readonly version: 1;
}

export type WhatsappRecoveryOutcome =
  | { readonly messages: number; readonly status: "recovered" }
  | {
    readonly messages: number;
    readonly reason: "sweep-failed" | "sweep-limit";
    readonly status: "degraded";
  };

export type WhatsappHealth =
  | { readonly state: "starting" }
  | { readonly state: "connected" }
  | { readonly reason: string; readonly state: "reconnecting" }
  | { readonly state: "needs_link" }
  | { readonly reason: string; readonly state: "failed" };

export type WhatsappDeliveryOutcome =
  | { readonly providerMessageId: string; readonly status: "confirmed" }
  | { readonly status: "ambiguous" }
  | { readonly reason: string; readonly retryable: boolean; readonly status: "failed" };

export type WhatsappQualification =
  | {
    readonly linkedJid: string;
    readonly status: "ready";
    readonly wacliVersion: string;
  }
  | { readonly status: "needs_link"; readonly wacliVersion: string };

export type WhatsappLinkStep =
  | { readonly code: string; readonly type: "qr" }
  | { readonly code: string; readonly type: "pairing_code" }
  | { readonly linkedJid: string; readonly type: "linked" }
  | { readonly reason: string; readonly type: "failed" };

/**
 * WhatsApp's CDN no longer serves this media (HTTP 403, 404, or 410). Only the phone can re-upload
 * it, through `wacli media retry`, which needs the store lock the running sync holds.
 */
export class WhatsappAttachmentExpiredError extends Error {
  readonly code = "attachment-expired" as const;

  constructor() {
    super("WhatsApp no longer has this media on its servers");
    this.name = "WhatsappAttachmentExpiredError";
  }
}

export interface WhatsappSubscription {
  close(): Promise<void>;
  /** Settles when the subscription ends without `close()`, e.g. after WhatsApp unlinks the device. */
  readonly terminated: Promise<void>;
}

export interface WhatsappPresence {
  setTyping(conversation: WhatsappConversationReference, typing: boolean): Promise<void>;
}

export interface ProntoWhatsapp {
  qualify(): Promise<WhatsappQualification>;
  subscribe(input: {
    readonly onEvent: (event: WhatsappEvent) => void | Promise<void>;
    readonly onHealth?: (health: WhatsappHealth) => void | Promise<void>;
    readonly onRecovery?: (outcome: WhatsappRecoveryOutcome) => void | Promise<void>;
  }): Promise<WhatsappSubscription>;
  /** Recent messages in an observed conversation, oldest first. */
  history(input: {
    readonly conversation: WhatsappConversationReference;
    readonly limit: number;
  }): Promise<WhatsappEvent[]>;
  /**
   * Sends `text`, or with `filePath` one file captioned with `text`. The file must be an absolute
   * path to a consumer-staged regular file of at most 100 MiB; the consumer deletes it afterwards.
   */
  reply(input: {
    readonly conversation: WhatsappConversationReference;
    readonly filePath?: string;
    readonly quote?: { readonly providerMessageId: string; readonly sender: string | null };
    readonly text: string;
  }): Promise<WhatsappDeliveryOutcome>;
  /**
   * Reacts to one message through the running subscription; an empty `emoji` clears the reaction.
   * `sender` is the message's sender and is required in groups. Fails retryably, without waiting,
   * when the subscription is not connected.
   */
  react(input: {
    readonly conversation: WhatsappConversationReference;
    readonly emoji: string;
    readonly providerMessageId: string;
    readonly sender: string | null;
  }): Promise<WhatsappDeliveryOutcome>;
  /**
   * Downloads the media of one message in an observed conversation into a private directory.
   * Throws when the message has no downloadable media or it exceeds `maxBytes`, and
   * `WhatsappAttachmentExpiredError` when WhatsApp's servers no longer have the media.
   */
  materializeAttachment(input: {
    readonly conversation: WhatsappConversationReference;
    readonly maxBytes: number;
    readonly providerMessageId: string;
  }): Promise<MaterializedWhatsappAttachment>;
  /** Present only when created with `presence: true`. */
  readonly presence?: WhatsappPresence;
  link(input?: { readonly phone?: string; readonly signal?: AbortSignal }): AsyncIterable<WhatsappLinkStep>;
  unlink(): Promise<void>;
  close(): Promise<void>;
}

export interface CreateProntoWhatsappOptions {
  readonly wacliPath: string;
  /** Consumer-owned private directory for the wacli session and index. Created with mode 0700. */
  readonly storeDir: string;
  /** Module checkpoint (watermark and recently delivered ids). */
  readonly statePath: string;
  /** Owner-private secret (at least 32 bytes) that signs conversation references. */
  readonly referenceKey: string;
  readonly recoveryLimits?: {
    /** Recovered messages older than this are skipped. Default 24 hours. */
    readonly maxAgeMs?: number;
    /** Live messages older than this on arrival are suppressed. Default 5 minutes. */
    readonly maxLiveAgeMs?: number;
    /** Most messages one recovery sweep delivers. Default 500. */
    readonly maxMessages?: number;
  };
  readonly scopeLimits?: {
    /** Lifetime of issued conversation references. Default 24 hours. */
    readonly ttlMs?: number;
  };
  readonly presence?: boolean;
  /**
   * Name this Mac shows under WhatsApp → Linked devices, set when the device links.
   * Defaults to wacli's own choice (the host name, or "wacli").
   */
  readonly deviceLabel?: string;
  /** Private directory for downloaded attachments. Defaults to a per-user temporary directory. */
  readonly attachmentsDir?: string;
}
