import type { ConversationReference, MessagesEvent } from "pronto-imessage";
import { matchTaggedMessage } from "pronto-imessage/tags";

export { findTagRanges } from "pronto-imessage/tags";

export interface ActivatedRequest {
  activationTag: string;
  chatId: number;
  conversation: ConversationReference;
  isFromMe: boolean;
  providerGuid: string;
  request: string;
  rowId: number;
}

export function activatedRequest(
  event: MessagesEvent,
  tags: readonly string[],
): ActivatedRequest | null {
  const message = event.message;
  if (!event.conversationFacts.ownerParticipated) return null;
  if (message.kind !== "message" || message.selfChatMirror) return null;
  const service = (message.service ?? event.conversationFacts.service)?.toLowerCase();
  if (service !== "imessage" && service !== "rcs") return null;
  if (message.text === null) return null;
  const activation = matchTaggedMessage(message.text, tags);
  if (activation.status === "ignored") return null;
  return {
    activationTag: activation.tag,
    chatId: event.conversation.chatId,
    conversation: event.conversation,
    isFromMe: message.fromMe,
    providerGuid: message.providerMessageId,
    request: activation.message,
    rowId: message.rowId,
  };
}
