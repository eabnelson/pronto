import type { MessagesEvent } from "../types.js";

/** Shared provider evidence rule for live intake and bounded history pages. */
export function isMirrorPair(message: MessagesEvent, original: MessagesEvent): boolean {
  if (original.conversation.chatId !== message.conversation.chatId ||
      !original.message.fromMe || original.message.text !== message.message.text ||
      message.message.rowId <= original.message.rowId ||
      message.message.occurredAt === null || original.message.occurredAt === null) return false;
  const messageTime = Date.parse(message.message.occurredAt);
  const originalTime = Date.parse(original.message.occurredAt);
  return Number.isFinite(messageTime) && Number.isFinite(originalTime) &&
    messageTime <= originalTime && originalTime - messageTime <= 1_000;
}

/** Classify only echoes whose outgoing witness is in this already-budgeted page. */
export function markHistoryMirrors(events: readonly MessagesEvent[]): MessagesEvent[] {
  const outgoing = new Map<string, MessagesEvent[]>();
  return events.map((event) => {
    const text = event.message.text;
    if (text === null) return event;
    const witnesses = outgoing.get(text) ?? [];
    if (event.message.fromMe) {
      witnesses.push(event);
      outgoing.set(text, witnesses);
      return event;
    }
    if (!witnesses.some((original) => isMirrorPair(event, original))) return event;
    return { ...event, message: { ...event.message, selfChatMirror: true } };
  });
}
