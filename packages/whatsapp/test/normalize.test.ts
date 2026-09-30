import { expect, test } from "bun:test";
import { deliveryKey, fromStoredRow, fromWebhook } from "../src/internal/normalize";
import { compareVersions, parseVersion } from "../src/internal/version";
import { ALICE, GROUP, row, webhook } from "./harness";

test("webhook kinds are classified from the flat wacli payload", () => {
  const kind = (fields: Record<string, unknown>) => fromWebhook(webhook({ id: "A", ...fields }))?.kind;
  expect(kind({})).toBe("message");
  expect(kind({ ReactionEmoji: "👍", ReactionToID: "B", Text: "" })).toBe("reaction");
  expect(kind({ Revoked: true, Text: "" })).toBe("revoke");
  expect(kind({ Edited: true, Text: "fixed" })).toBe("edit");
  expect(kind({ Poll: { Options: ["a"], Question: "q" }, Text: "" })).toBe("poll");
  expect(kind({ PollVote: { PollMessageID: "P" }, Text: "" })).toBe("poll");
  expect(kind({ Call: { CallID: "c" }, Text: "" })).toBe("call");
  expect(kind({ Text: "", UnhandledPayload: "stickerPackMessage" })).toBe("unsupported");
  expect(kind({ Text: "" })).toBe("unsupported");
  expect(kind({ Media: { Caption: "look", MimeType: "image/jpeg", Type: "image" }, Text: "" })).toBe("message");
});

test("webhook normalization drops broadcasts and newsletters and keeps captions", () => {
  expect(fromWebhook(webhook({ chat: "status@broadcast", id: "S" }))).toBeNull();
  expect(fromWebhook(webhook({ chat: "12345@broadcast", id: "B" }))).toBeNull();
  expect(fromWebhook(webhook({ chat: "120363@newsletter", id: "N" }))).toBeNull();
  expect(fromWebhook({ EventType: "receipt", Chat: ALICE, ID: "R" })).toBeNull();
  expect(fromWebhook(webhook({ chat: "-bad@s.whatsapp.net", id: "X" }))).toBeNull();

  const media = fromWebhook(webhook({
    Media: { Caption: "caption", FileLength: 10, Filename: "a.jpg", MimeType: "image/jpeg", Type: "image" },
    Text: "",
    chat: GROUP,
    id: "M",
    sender: "15550002222:3@s.whatsapp.net",
  }));
  expect(media).toMatchObject({
    chatJid: GROUP,
    media: { caption: "caption", filename: "a.jpg", mimeType: "image/jpeg", type: "image" },
    senderJid: ALICE,
    text: "caption",
  });
});

test("stored rows fold edits into the message and skip deleted rows", () => {
  expect(fromStoredRow(row({ Edited: true, id: "E", ts: new Date().toISOString() }))?.kind).toBe("message");
  expect(fromStoredRow(row({ DeletedForMe: true, id: "D", ts: new Date().toISOString() }))).toBeNull();
  expect(fromStoredRow(row({ ReactionToID: "A", Text: "", id: "R", ts: new Date().toISOString() }))?.kind)
    .toBe("reaction");
  expect(fromStoredRow(row({ chat: "status@broadcast", id: "S", ts: new Date().toISOString() }))).toBeNull();
});

test("edits and revokes do not collide with the message they target", () => {
  const original = fromWebhook(webhook({ id: "A" }));
  const edit = fromWebhook(webhook({ Edited: true, id: "A", text: "new" }));
  const revoke = fromWebhook(webhook({ Revoked: true, Text: "", id: "A" }));
  const keys = new Set([original, edit, revoke].map((message) => deliveryKey(message!)));
  expect(keys.size).toBe(3);
});

test("version parsing and comparison", () => {
  expect(parseVersion("0.19.0\n")).toBe("0.19.0");
  expect(parseVersion("wacli v0.20.1-dev")).toBe("0.20.1");
  expect(parseVersion("dev")).toBeNull();
  expect(compareVersions("0.18.9", "0.19.0")).toBe(-1);
  expect(compareVersions("0.19.0", "0.19.0")).toBe(0);
  expect(compareVersions("1.0.0", "0.19.0")).toBe(1);
});
