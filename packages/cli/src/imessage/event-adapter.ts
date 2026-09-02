import type { MessagesAttachment, MessagesEvent } from "pronto-imessage";

export function rawFromMessagesEvent(
  event: MessagesEvent,
  attachmentId?: (attachment: MessagesAttachment) => string | undefined,
): Record<string, unknown> {
  return {
    attachments: event.message.attachments.map((attachment) => {
      const id = attachmentId?.(attachment);
      return {
        ...(id === undefined ? {} : { attachment_id: id }),
        available: attachment.available,
        mime_type: attachment.mimeType,
        name: attachment.name,
        total_bytes: attachment.sizeBytes,
      };
    }),
    chat_id: event.conversation.chatId,
    created_at: event.message.occurredAt,
    guid: event.message.providerMessageId,
    id: event.message.rowId,
    is_from_me: event.message.fromMe,
    reaction: event.message.reaction,
    sender: event.message.sender,
    service: event.message.service,
    text: event.message.text,
    url_preview: event.message.urlPreview,
  };
}
