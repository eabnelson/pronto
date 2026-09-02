export interface ConversationReference {
  readonly chatId: number;
  readonly expiresAt: string;
  readonly provider: "apple-messages";
  readonly token: string;
  readonly version: 1;
}

export interface AttachmentReference {
  readonly expiresAt: string;
  readonly provider: "apple-messages";
  readonly token: string;
  readonly version: 1;
}

export interface ConversationFacts {
  readonly ownerParticipated: boolean;
  readonly service: string | null;
}

export interface MessagesAttachment {
  readonly available: boolean;
  readonly mimeType: string | null;
  readonly name: string | null;
  readonly providerAttachmentId: string | null;
  readonly reference?: AttachmentReference;
  readonly sizeBytes: number | null;
}

export interface MessagesEvent {
  readonly conversation: ConversationReference;
  readonly conversationFacts: ConversationFacts;
  readonly message: {
    readonly attachments: readonly MessagesAttachment[];
    readonly fromMe: boolean;
    readonly kind: "message" | "poll" | "reaction";
    readonly occurredAt: string | null;
    readonly providerMessageId: string;
    readonly reaction: {
      readonly added: boolean | null;
      readonly targetProviderMessageId: string;
      readonly type: string;
    } | null;
    readonly rowId: number;
    readonly replyToProviderMessageId: string | null;
    readonly replyToText: string | null;
    readonly sender: string | null;
    readonly selfChatMirror: boolean;
    readonly service: string | null;
    readonly text: string | null;
    readonly urlPreview: boolean;
  };
  readonly provider: "apple-messages";
  readonly version: 1;
}

export type DeliveryOutcome =
  | { readonly providerMessageId: string; readonly status: "confirmed" }
  | { readonly status: "ambiguous" }
  | { readonly retryable: boolean; readonly status: "failed" };

export interface MessagesQualification {
  readonly databaseGeneration: string;
  readonly degradedCapabilities: readonly string[];
  readonly providerVersion: string;
  readonly status: "ready";
}

export type MessagesRecoveryReason =
  | "age-limit"
  | "database-generation-changed"
  | "database-generation-unavailable"
  | "duration-limit"
  | "invalid-provider-page"
  | "provider-unavailable"
  | "row-limit";

export type MessagesRecoveryOutcome =
  | {
    readonly rows: number;
    readonly status: "recovered";
  }
  | {
    readonly action: "live-events-only";
    readonly reason: MessagesRecoveryReason;
    readonly rows: number;
    readonly status: "degraded";
  };

export interface MessagesDiagnostics {
  readonly attempt: number;
  readonly catchUpRows: number;
  readonly databaseGenerationDigest?: string;
  readonly nextRetryAt?: string;
  readonly recoveryReason?: MessagesRecoveryReason;
  readonly restartCount: number;
  readonly state: "closed" | "degraded" | "ready" | "recovering" | "starting";
}

export interface MessagesRecoveryLimits {
  readonly maxAgeMs?: number;
  readonly maxDurationMs?: number;
  readonly maxRows?: number;
}

export interface MessagesScopeLimits {
  readonly maxAttachmentBytes?: number;
  readonly maxAttachmentCount?: number;
  readonly maxHistoryBytes?: number;
  readonly maxHistoryMessages?: number;
  readonly maxHistoryRows?: number;
  readonly maxHistoryRpcCalls?: number;
  readonly ttlMs?: number;
}

export interface MessagesHistoryBudget {
  readonly maxBytes: number;
  readonly maxMessages: number;
  readonly maxRows: number;
  readonly maxRpcCalls: number;
}

export interface MessagesHistoryPage {
  readonly continuation?: string;
  readonly hasMore: boolean;
  readonly messages: readonly MessagesEvent[];
  readonly scannedBytes: number;
  readonly scannedRows: number;
}

export interface MaterializedAttachment {
  dispose(): Promise<void>;
  readonly mimeType: string;
  readonly name: string;
  readonly path: string;
  readonly sha256: string;
  readonly sizeBytes: number;
}

export interface CreateProntoMessagesOptions {
  readonly attachmentsRoot?: string;
  readonly imsgPath: string;
  readonly legacyUnscopedCursor?: number;
  readonly recoveryLimits?: MessagesRecoveryLimits;
  readonly referenceKey?: string;
  readonly scopeLimits?: MessagesScopeLimits;
  readonly scratchRoot?: string;
  readonly statePath?: string;
}

export interface MessagesSubscription {
  close(): Promise<void>;
  readonly terminated: Promise<void>;
}

export interface ProntoMessages {
  close(): Promise<void>;
  diagnostics(): MessagesDiagnostics;
  history(input: {
    readonly budget: MessagesHistoryBudget;
    readonly continuation?: string;
    readonly conversation: ConversationReference;
    readonly includeReactions?: boolean;
    readonly mode?: "forward" | "recent";
  }): Promise<MessagesHistoryPage>;
  materializeAttachment(input: {
    readonly attachment: AttachmentReference;
    readonly conversation: ConversationReference;
    readonly maxBytes: number;
  }): Promise<MaterializedAttachment>;
  qualify(): Promise<MessagesQualification>;
  reply(input: {
    readonly conversation: ConversationReference;
    readonly text: string;
  }): Promise<DeliveryOutcome>;
  subscribe(input: {
    readonly onEvent: (event: MessagesEvent) => void | Promise<void>;
    readonly onOverflow?: (resumeAfterRowId: number) => void | Promise<void>;
    readonly onRecovery?: (outcome: MessagesRecoveryOutcome) => void | Promise<void>;
  }): Promise<MessagesSubscription>;
}
