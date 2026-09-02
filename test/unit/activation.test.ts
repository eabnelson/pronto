import { describe, expect, test } from "bun:test";
import { activatedRequest } from "../../packages/cli/src/activation";
import { normalizeMessage } from "../../packages/cli/src/imessage/message";

const baseMessage = {
  chat_id: 42,
  date: "2026-08-15T12:00:00Z",
  guid: "INBOUND-1",
  id: 100,
  is_from_me: false,
  sender: "+15550000001",
  service: "iMessage",
  text: "@helper summarize this",
};

describe("activation", () => {
  test("accepts bounded tags from eligible iMessage chats", () => {
    const message = normalizeMessage(baseMessage);
    expect(activatedRequest(message, ["@helper", "@plan"], true)).toMatchObject({
      activationTag: "@helper",
      chatId: 42,
      providerGuid: "INBOUND-1",
      request: "summarize this",
    });
  });

  test("treats a tag-only message as a conversation-help request", () => {
    const message = normalizeMessage({ ...baseMessage, text: "@HELPER" });
    expect(activatedRequest(message, ["@helper"], true)).toMatchObject({
      activationTag: "@helper",
      request: "Help with this conversation.",
    });
  });

  test("does not match email text or a longer tag", () => {
    for (const text of ["mail me@helper.com", "@helperbot do this"]) {
      expect(
        activatedRequest(normalizeMessage({ ...baseMessage, text }), ["@helper"], true),
      ).toBeNull();
    }
  });

  test("fails closed for non-iMessage, untyped, reaction, and owner-absent events", () => {
    for (const candidate of [
      { ...baseMessage, service: "SMS" },
      { ...baseMessage, service: undefined },
      { ...baseMessage, reaction: { type: "love" }, text: "@helper" },
    ]) {
      expect(activatedRequest(normalizeMessage(candidate), ["@helper"], true)).toBeNull();
    }
    expect(activatedRequest(normalizeMessage(baseMessage), ["@helper"], false)).toBeNull();
  });

  test("accepts tagged text with attachment metadata but not attachment-only events", () => {
    const attachment = { filename: "notes.pdf", mime_type: "application/pdf" };
    expect(
      activatedRequest(
        normalizeMessage({ ...baseMessage, attachments: [attachment] }),
        ["@helper"],
        true,
      )?.attachments,
    ).toEqual([attachment]);
    expect(
      activatedRequest(
        normalizeMessage({ ...baseMessage, attachments: [attachment], text: null }),
        ["@helper"],
        true,
      ),
    ).toBeNull();
  });

  test("removes every occurrence of one matched tag and ignores ambiguous tags", () => {
    expect(
      activatedRequest(
        normalizeMessage({ ...baseMessage, text: "(@HELPER) summarize @helper please" }),
        ["@helper", "@plan"],
        true,
      )?.request,
    ).toBe("summarize please");
    expect(
      activatedRequest(
        normalizeMessage({ ...baseMessage, text: "@helper ask @plan what to do" }),
        ["@helper", "@plan"],
        true,
      ),
    ).toBeNull();
  });
});
