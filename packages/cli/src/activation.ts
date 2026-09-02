import type { ConversationReference, MessagesEvent } from "pronto-imessage";

export interface ActivatedRequest {
  activationTag: string;
  chatId: number;
  conversation: ConversationReference;
  isFromMe: boolean;
  providerGuid: string;
  request: string;
  rowId: number;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function findTagRanges(text: string, tag: string): readonly [number, number][] {
  const matcher = new RegExp(
    `(^|[^\\p{L}\\p{N}\\p{M}._@-])(${escapeRegExp(tag)})(?=$|[^\\p{L}\\p{N}\\p{M}._@-])`,
    "giu",
  );
  return [...text.matchAll(matcher)].map((match) => {
    const prefixLength = match[1]?.length ?? 0;
    const start = (match.index ?? 0) + prefixLength;
    return [start, start + (match[2]?.length ?? tag.length)] as const;
  });
}

function removeOneMatchedTag(
  text: string,
  tags: readonly string[],
): { activationTag: string; request: string } | null {
  const matches = tags.flatMap((tag) => {
    const ranges = findTagRanges(text, tag);
    return ranges.length === 0 ? [] : [{ ranges, tag }];
  });
  if (matches.length !== 1) return null;

  let request = text;
  for (const [start, end] of [...matches[0]!.ranges].reverse()) {
    request = `${request.slice(0, start)}${request.slice(end)}`;
  }
  request = request
    .replace(/\(\s*\)|\[\s*\]|\{\s*\}/gu, " ")
    .replace(/\s+([,:;.!?])/gu, "$1")
    .replace(/^[\s,:;.!?]+|[\s,:;.!?]+$/gu, "")
    .replace(/\s{2,}/gu, " ")
    .trim();
  return {
    activationTag: matches[0]!.tag,
    request: request.length === 0 ? "Help with this conversation." : request,
  };
}

export function activatedRequest(
  event: MessagesEvent,
  tags: readonly string[],
): ActivatedRequest | null {
  const message = event.message;
  if (!event.conversationFacts.ownerParticipated) return null;
  if (message.kind !== "message" || message.selfChatMirror) return null;
  if ((message.service ?? event.conversationFacts.service)?.toLowerCase() !== "imessage") return null;
  if (message.text === null) return null;
  const activation = removeOneMatchedTag(message.text, tags);
  if (activation === null) return null;
  return {
    activationTag: activation.activationTag,
    chatId: event.conversation.chatId,
    conversation: event.conversation,
    isFromMe: message.fromMe,
    providerGuid: message.providerMessageId,
    request: activation.request,
    rowId: message.rowId,
  };
}
