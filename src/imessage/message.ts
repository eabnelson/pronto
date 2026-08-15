export interface NormalizedMessage {
  attachments: ReadonlyArray<Record<string, unknown>>;
  chatId: number | null;
  date: string | null;
  isFromMe: boolean;
  kind: "message" | "reaction" | "poll" | "unknown";
  providerGuid: string | null;
  rowId: number | null;
  sender: string | null;
  service: string | null;
  text: string | null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function normalizeMessage(value: unknown): NormalizedMessage {
  const raw = record(value) ?? {};
  const attachments = Array.isArray(raw.attachments)
    ? raw.attachments.flatMap((attachment) => {
        const normalized = record(attachment);
        return normalized === null ? [] : [{ ...normalized }];
      })
    : [];
  const reaction = record(raw.reaction);
  const poll = record(raw.poll);
  const kind = reaction !== null ? "reaction" : poll !== null ? "poll" : "message";

  return {
    attachments,
    chatId:
      typeof raw.chat_id === "number" && Number.isSafeInteger(raw.chat_id) && raw.chat_id > 0
        ? raw.chat_id
        : null,
    date: typeof raw.date === "string" ? raw.date : null,
    isFromMe: raw.is_from_me === true,
    kind,
    providerGuid: typeof raw.guid === "string" && raw.guid.length > 0 ? raw.guid : null,
    rowId:
      typeof raw.id === "number" && Number.isSafeInteger(raw.id) && raw.id > 0
        ? raw.id
        : null,
    sender: typeof raw.sender === "string" ? raw.sender : null,
    service: typeof raw.service === "string" ? raw.service : null,
    text: typeof raw.text === "string" ? raw.text : null,
  };
}
