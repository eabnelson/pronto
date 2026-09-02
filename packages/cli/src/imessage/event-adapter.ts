import type { MessagesAttachment, MessagesEvent } from "pronto-imessage";

export interface CurrentChatMessage {
  readonly attachments: readonly {
    readonly attachmentId?: string;
    readonly available: boolean;
    readonly mimeType: string | null;
    readonly name: string | null;
    readonly sizeBytes: number | null;
  }[];
  readonly fromMe: boolean;
  readonly kind: "message" | "poll" | "reaction";
  readonly messageGuid: string;
  readonly occurredAt: string | null;
  readonly reaction: MessagesEvent["message"]["reaction"];
  readonly sender: string | null;
  readonly service: string | null;
  readonly text: string | null;
  readonly urlPreview: boolean;
}

export function currentChatMessageFromEvent(
  event: MessagesEvent,
  attachmentId?: (attachment: MessagesAttachment) => string | undefined,
): CurrentChatMessage {
  return {
    attachments: event.message.attachments.map((attachment) => {
      const id = attachmentId?.(attachment);
      return {
        ...(id === undefined ? {} : { attachmentId: id }),
        available: attachment.available,
        mimeType: attachment.mimeType,
        name: attachment.name,
        sizeBytes: attachment.sizeBytes,
      };
    }),
    fromMe: event.message.fromMe,
    kind: event.message.kind,
    messageGuid: event.message.providerMessageId,
    occurredAt: event.message.occurredAt,
    reaction: event.message.reaction,
    sender: event.message.sender,
    service: event.message.service,
    text: event.message.text,
    urlPreview: event.message.urlPreview,
  };
}

export function parseCurrentChatMessage(value: unknown): CurrentChatMessage | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const message = value as Partial<CurrentChatMessage>;
  if (
    !Array.isArray(message.attachments) || typeof message.fromMe !== "boolean" ||
    (message.kind !== "message" && message.kind !== "poll" && message.kind !== "reaction") ||
    typeof message.messageGuid !== "string" || message.messageGuid.length === 0 ||
    (message.text !== null && typeof message.text !== "string")
  ) return null;
  return message as CurrentChatMessage;
}
