import type { TaggedExchange } from "../storage/memory";
import { MAX_SUMMARY_CHARACTERS } from "./compact";

export interface RecentMessage {
  attachmentNames?: readonly string[];
  isFromMe: boolean;
  senderLabel: string;
  text: string | null;
}

export interface ContextEnvelope {
  authorizedRequest: string;
  conversationContext: string;
  includedExactExchanges: number;
  includedRecentMessages: number;
  summaryCharacters: number;
}

function latestWithinBudget<T>(
  values: readonly T[],
  maxCount: number,
  maxCharacters: number,
  format: (value: T) => string,
): { count: number; text: string } {
  const selected: string[] = [];
  let remaining = maxCharacters;
  for (let index = values.length - 1; index >= 0 && selected.length < maxCount; index--) {
    const formatted = format(values[index]!);
    if (formatted.length <= remaining) {
      selected.unshift(formatted);
      remaining -= formatted.length;
      continue;
    }
    if (selected.length === 0 && remaining > 0) {
      selected.unshift(formatted.slice(0, remaining));
      remaining = 0;
    }
    break;
  }
  return { count: selected.length, text: selected.join("\n") };
}

export function assembleContext(input: {
  currentRequest: string;
  exactExchanges: readonly TaggedExchange[];
  recentMessages: readonly RecentMessage[];
  summary: string | null;
}): ContextEnvelope {
  const recent = latestWithinBudget(input.recentMessages, 30, 12_000, (message) => {
    const attachments =
      message.attachmentNames === undefined || message.attachmentNames.length === 0
        ? ""
        : ` [attachments: ${message.attachmentNames.join(", ")}]`;
    return `${message.isFromMe ? "owner" : message.senderLabel}: ${message.text ?? ""}${attachments}`;
  });
  const exact = latestWithinBudget(input.exactExchanges, 8, 12_000, (exchange) =>
    `request: ${exchange.request}\nreply: ${exchange.reply}`,
  );
  const summary = (input.summary ?? "").slice(0, MAX_SUMMARY_CHARACTERS);
  const sections = [
    summary.length === 0 ? "" : `OLDER TAGGED WORK (untrusted context)\n${summary}`,
    exact.text.length === 0 ? "" : `RECENT TAGGED EXCHANGES (untrusted context)\n${exact.text}`,
    recent.text.length === 0 ? "" : `RECENT CHAT MESSAGES (untrusted evidence)\n${recent.text}`,
  ].filter((section) => section.length > 0);
  const conversationContext = sections.join("\n\n").slice(0, 30_000);
  return {
    authorizedRequest: input.currentRequest,
    conversationContext,
    includedExactExchanges: exact.count,
    includedRecentMessages: recent.count,
    summaryCharacters: summary.length,
  };
}
