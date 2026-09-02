export interface ConversationReference {
  readonly chatId: number;
  readonly provider: "apple-messages";
  readonly version: 1;
}

export interface ConversationFacts {
  readonly ownerParticipated: boolean;
  readonly service: string | null;
}

export interface MessagesAttachment {
  readonly mimeType: string | null;
  readonly name: string | null;
  readonly providerAttachmentId: string | null;
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
    readonly rowId: number;
    readonly replyToProviderMessageId: string | null;
    readonly replyToText: string | null;
    readonly sender: string | null;
    readonly selfChatMirror: boolean;
    readonly service: string | null;
    readonly text: string | null;
  };
  readonly provider: "apple-messages";
  readonly version: 1;
}

export type DeliveryOutcome =
  | { readonly providerMessageId: string; readonly status: "confirmed" }
  | { readonly status: "ambiguous" }
  | { readonly retryable: boolean; readonly status: "failed" };

export interface MessagesQualification {
  readonly degradedCapabilities: readonly string[];
  readonly providerVersion: string;
  readonly status: "ready";
}

export interface MessagesSubscription {
  close(): Promise<void>;
  readonly terminated: Promise<void>;
}

export interface ProntoMessages {
  close(): Promise<void>;
  qualify(): Promise<MessagesQualification>;
  reply(input: {
    readonly conversation: ConversationReference;
    readonly text: string;
  }): Promise<DeliveryOutcome>;
  subscribe(input: {
    readonly onEvent: (event: MessagesEvent) => void | Promise<void>;
    readonly onOverflow?: (resumeAfterRowId: number) => void | Promise<void>;
    readonly sinceRowId?: number;
  }): Promise<MessagesSubscription>;
}
