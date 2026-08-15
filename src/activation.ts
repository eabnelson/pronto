import type { NormalizedMessage } from "./imessage/message";

export interface ActivatedRequest {
  attachments: ReadonlyArray<Record<string, unknown>>;
  chatId: number;
  isFromMe: boolean;
  providerGuid: string;
  request: string;
  rowId: number | null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function removeBoundedTag(text: string, tag: string): string | null {
  const matcher = new RegExp(
    `(^|[^A-Za-z0-9_.+\\-])(${escapeRegExp(tag)})(?![A-Za-z0-9_\\-])`,
    "i",
  );
  const match = matcher.exec(text);
  if (match === null || match.index === undefined) return null;
  const prefixLength = match[1]?.length ?? 0;
  const start = match.index + prefixLength;
  const request = `${text.slice(0, start)}${text.slice(start + tag.length)}`
    .replace(/\s+/g, " ")
    .trim();
  return request.length === 0 ? "Help with this conversation." : request;
}

export function activatedRequest(
  message: NormalizedMessage,
  tag: string,
  ownerParticipated: boolean,
): ActivatedRequest | null {
  if (!ownerParticipated) return null;
  if (message.kind !== "message") return null;
  if (message.service?.toLowerCase() !== "imessage") return null;
  if (message.chatId === null || message.providerGuid === null || message.text === null) {
    return null;
  }
  const request = removeBoundedTag(message.text, tag);
  if (request === null) return null;
  return {
    attachments: message.attachments,
    chatId: message.chatId,
    isFromMe: message.isFromMe,
    providerGuid: message.providerGuid,
    request,
    rowId: message.rowId,
  };
}
