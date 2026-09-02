import type { NormalizedMessage } from "./imessage/message";

export interface ActivatedRequest {
  activationTag: string;
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
  message: NormalizedMessage,
  tags: readonly string[],
  ownerParticipated: boolean,
): ActivatedRequest | null {
  if (!ownerParticipated) return null;
  if (message.kind !== "message") return null;
  if (message.service?.toLowerCase() !== "imessage") return null;
  if (message.chatId === null || message.providerGuid === null || message.text === null) {
    return null;
  }
  const activation = removeOneMatchedTag(message.text, tags);
  if (activation === null) return null;
  return {
    activationTag: activation.activationTag,
    attachments: message.attachments,
    chatId: message.chatId,
    isFromMe: message.isFromMe,
    providerGuid: message.providerGuid,
    request: activation.request,
    rowId: message.rowId,
  };
}
