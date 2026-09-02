import { describe, expect, test } from "bun:test";
import { activatedRequest } from "../../packages/cli/src/activation";
import type { MessagesEvent } from "pronto-imessage";

function event(overrides: {
  readonly fromMe?: boolean;
  readonly kind?: MessagesEvent["message"]["kind"];
  readonly ownerParticipated?: boolean;
  readonly selfChatMirror?: boolean;
  readonly service?: string | null;
  readonly text?: string | null;
} = {}): MessagesEvent {
  return {
    conversation: {
      chatId: 42,
      expiresAt: "2026-09-01T13:00:00.000Z",
      provider: "apple-messages",
      token: "conversation-token",
      version: 1,
    },
    conversationFacts: {
      ownerParticipated: overrides.ownerParticipated ?? true,
      service: overrides.service === undefined ? "iMessage" : overrides.service,
    },
    message: {
      attachments: [],
      fromMe: overrides.fromMe ?? false,
      kind: overrides.kind ?? "message",
      occurredAt: "2026-09-01T12:00:00.000Z",
      providerMessageId: "message-guid",
      reaction: null,
      replyToProviderMessageId: null,
      replyToText: null,
      rowId: 101,
      selfChatMirror: overrides.selfChatMirror ?? false,
      sender: "+15555550100",
      service: overrides.service === undefined ? "iMessage" : overrides.service,
      text: overrides.text === undefined ? "@helper summarize this" : overrides.text,
      urlPreview: false,
    },
    provider: "apple-messages",
    version: 1,
  };
}

describe("activation", () => {
  test("accepts one bounded tag from an eligible normalized event", () => {
    expect(activatedRequest(event(), ["@helper"])).toEqual({
      activationTag: "@helper",
      chatId: 42,
      conversation: event().conversation,
      isFromMe: false,
      providerGuid: "message-guid",
      request: "summarize this",
      rowId: 101,
    });
  });

  test("treats a tag-only message as a conversation-help request", () => {
    expect(activatedRequest(event({ text: "@HELPER" }), ["@helper"])?.request)
      .toBe("Help with this conversation.");
  });

  test("does not match email text, longer tags, or multiple configured tags", () => {
    for (const text of ["mail helper@example.com", "@helper2 hi", "@helper ask @plan"]) {
      expect(activatedRequest(event({ text }), ["@helper", "@plan"])).toBeNull();
    }
  });

  test("fails closed for non-iMessage, reactions, mirrors, and owner-absent chats", () => {
    for (const candidate of [
      event({ service: "SMS" }),
      event({ kind: "reaction" }),
      event({ selfChatMirror: true }),
      event({ ownerParticipated: false }),
      event({ text: null }),
    ]) {
      expect(activatedRequest(candidate, ["@helper"])).toBeNull();
    }
  });

  test("removes every occurrence of the one matched tag", () => {
    expect(activatedRequest(
      event({ text: "(@HELPER) summarize @helper please" }),
      ["@helper"],
    )?.request).toBe("summarize please");
  });
});
