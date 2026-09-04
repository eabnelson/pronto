import { expect, test } from "bun:test";
import { ImsgCurrentChatSource } from "../../packages/cli/src/imessage/current-chat-source";
import type {
  AttachmentReference,
  ConversationReference,
  MessagesEvent,
  ProntoMessages,
} from "pronto-imessage";

const conversation: ConversationReference = {
  chatId: 42,
  expiresAt: "2026-09-01T12:15:00.000Z",
  provider: "apple-messages",
  token: "conversation-token",
  version: 1,
};

const attachment: AttachmentReference = {
  expiresAt: conversation.expiresAt,
  provider: "apple-messages",
  token: "attachment-token",
  version: 1,
};

const event: MessagesEvent = {
  conversation,
  conversationFacts: { ownerParticipated: true, service: "iMessage" },
  message: {
    attachments: [{
      available: true,
      mimeType: "image/png",
      name: "photo.png",
      providerAttachmentId: "provider-attachment-id",
      reference: attachment,
      sizeBytes: 12,
    }],
    destinationCallerId: null,
    fromMe: false,
    kind: "message",
    occurredAt: "2026-09-01T12:00:00.000Z",
    providerMessageId: "MSG-1",
    reaction: null,
    replyToProviderMessageId: null,
    replyToText: null,
    rowId: 1,
    sender: "participant",
    selfChatMirror: false,
    service: "iMessage",
    text: "photo",
    urlPreview: true,
  },
  provider: "apple-messages",
  version: 1,
};

test("queries details, rich history, and materialized attachments through public scope", async () => {
  const calls: string[] = [];
  const messages: ProntoMessages = {
    close: async () => undefined,
    diagnostics: () => ({ attempt: 0, catchUpRows: 0, restartCount: 0, state: "ready" }),
    history: async () => {
      calls.push("history");
      return { hasMore: false, messages: [event], scannedBytes: 12, scannedRows: 1 };
    },
    materializeAttachment: async (input) => {
      calls.push(`attachment:${input.attachment.token}`);
      return {
        dispose: async () => undefined,
        mimeType: "image/png",
        name: "photo.png",
        path: "/tmp/pronto-photo.png",
        sha256: "digest",
        sizeBytes: 12,
      };
    },
    qualify: async () => ({
      databaseGeneration: "generation",
      degradedCapabilities: [],
      providerVersion: "0.14.1",
      status: "ready",
    }),
    reply: async () => ({ providerMessageId: "reply", status: "confirmed" }),
    resolveConversation: async () => null,
    subscribe: async () => ({
      close: async () => undefined,
      terminated: new Promise<void>(() => undefined),
    }),
  };
  const source = new ImsgCurrentChatSource(messages, (chatId) => chatId === 42
    ? { facts: event.conversationFacts, reference: conversation }
    : undefined);

  expect(await source.details(42)).toEqual({
    owner_participated: true,
    provider: "apple-messages",
    service: "iMessage",
  });
  const history = await source.history(42, 30) as {
    messages: Array<{ attachments: Array<{ attachmentId: string }>; urlPreview: boolean }>;
  };
  expect(history.messages[0]?.urlPreview).toBeTrue();
  expect(JSON.stringify(history)).not.toContain("attachment-token");
  expect(JSON.stringify(history)).not.toContain("/tmp/pronto-photo.png");
  const attachmentId = history.messages[0]!.attachments[0]!.attachmentId;
  expect(attachmentId).toEqual(expect.any(String));
  expect(await source.attachment(42, "MSG-1", attachmentId)).toEqual({
    attachmentId,
    messageGuid: "MSG-1",
    name: "photo.png",
    path: "/tmp/pronto-photo.png",
  });
  expect(calls).toEqual(["history", "attachment:attachment-token"]);
  await source.close();
});
