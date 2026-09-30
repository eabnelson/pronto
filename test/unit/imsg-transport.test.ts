import { expect, test } from "bun:test";
import type { ChannelActivation, ChatAddress } from "../../packages/cli/src/channels/types";
import { ImessageChannel } from "../../packages/cli/src/imessage/channel";
import { ImsgTransport } from "../../packages/cli/src/imessage/transport";
import type {
  DeliveryOutcome,
  MessagesEvent,
  MessagesHistoryPage,
  MessagesQualification,
  MessagesSubscription,
  ProntoMessages,
} from "pronto-imessage";

function event(overrides: {
  readonly fromMe?: boolean;
  readonly guid?: string;
  readonly selfChatMirror?: boolean;
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
    conversationFacts: { ownerParticipated: true, service: "iMessage" },
    message: {
      attachments: [],
      destinationCallerId: null,
      fromMe: overrides.fromMe ?? false,
      kind: "message",
      occurredAt: "2026-09-01T12:00:00.000Z",
      providerMessageId: overrides.guid ?? "message-guid",
      reaction: null,
      replyToProviderMessageId: null,
      replyToText: null,
      rowId: 101,
      selfChatMirror: overrides.selfChatMirror ?? false,
      sender: "+15555550100",
      service: "iMessage",
      text: overrides.text === undefined ? "@helper do this" : overrides.text,
      urlPreview: false,
    },
    provider: "apple-messages",
    version: 1,
  };
}

class FakeMessages implements ProntoMessages {
  events: MessagesEvent[] = [];
  historyPage: MessagesHistoryPage = {
    hasMore: false,
    messages: [],
    scannedBytes: 0,
    scannedRows: 0,
  };
  qualification: MessagesQualification = {
    databaseGeneration: "generation",
    degradedCapabilities: ["polls"],
    providerVersion: "0.14.1",
    status: "ready",
  };
  replyOutcome: DeliveryOutcome = { providerMessageId: "sent-guid", status: "confirmed" };
  historyInput: Parameters<ProntoMessages["history"]>[0] | undefined;
  replyInput: Parameters<ProntoMessages["reply"]>[0] | undefined;

  async close(): Promise<void> {}
  diagnostics(): ReturnType<ProntoMessages["diagnostics"]> {
    return { attempt: 0, catchUpRows: 0, restartCount: 0, state: "ready" };
  }
  async history(input: Parameters<ProntoMessages["history"]>[0]): Promise<MessagesHistoryPage> {
    this.historyInput = input;
    return this.historyPage;
  }
  async materializeAttachment(
    _input: Parameters<ProntoMessages["materializeAttachment"]>[0],
  ): ReturnType<ProntoMessages["materializeAttachment"]> {
    throw new Error("not used");
  }
  async qualify(): Promise<MessagesQualification> {
    return this.qualification;
  }
  async reply(input: Parameters<ProntoMessages["reply"]>[0]): Promise<DeliveryOutcome> {
    this.replyInput = input;
    return this.replyOutcome;
  }
  async resolveConversation(): ReturnType<ProntoMessages["resolveConversation"]> {
    return null;
  }
  async subscribe(
    input: Parameters<ProntoMessages["subscribe"]>[0],
  ): Promise<MessagesSubscription> {
    for (const value of this.events) await input.onEvent(value);
    return { close: async () => undefined, terminated: new Promise<void>(() => undefined) };
  }
}

test("standalone activation consumes normalized Pronto events and caches exact scope", () => {
  const messages = new FakeMessages();
  const transport = new ImsgTransport(messages);
  expect(transport.activationFor(event(), ["@helper"])?.request).toBe("do this");
  expect(transport.conversationContext(42)).toEqual({
    facts: { ownerParticipated: true, service: "iMessage" },
    reference: event().conversation,
  });
  expect(transport.activationFor(event({ selfChatMirror: true }), ["@helper"])).toBeNull();
});

test("standalone echo suppression remains product policy around Pronto", () => {
  const messages = new FakeMessages();
  const transport = new ImsgTransport(messages, {
    matchesOutboundEcho: (chatId, text) => chatId === 42 && text === "@helper sent",
  });
  expect(transport.activationFor(
    event({ fromMe: true, text: "@helper sent" }),
    ["@helper"],
  )).toBeNull();
});

test("watch, history, qualification, and delivery use only the public Messages interface", async () => {
  const messages = new FakeMessages();
  messages.events = [event()];
  messages.historyPage = {
    hasMore: false,
    messages: [event({ guid: "history-guid", text: "context" })],
    scannedBytes: 20,
    scannedRows: 1,
  };
  const transport = new ImsgTransport(messages);
  const activations: string[] = [];
  const rows: number[] = [];
  const watch = await transport.watch({
    onActivation: (activation) => { activations.push(activation.providerGuid); },
    onMessageRowId: (rowId) => { rows.push(rowId); },
    tags: ["@helper"],
  });
  await watch.close();

  expect(activations).toEqual(["message-guid"]);
  expect(rows).toEqual([101]);
  expect(await transport.qualify()).toEqual({ degraded: ["polls"], version: "0.14.1" });
  expect(await transport.recentMessages(42, 4)).toEqual([expect.objectContaining({
    messageGuid: "history-guid",
    text: "context",
  })]);
  expect(messages.historyInput).toMatchObject({
    budget: { maxMessages: 4, maxRows: 4, maxRpcCalls: 1 },
    conversation: event().conversation,
  });
  expect(await transport.sendText(42, "reply")).toEqual({
    disposition: "confirmed",
    guid: "sent-guid",
  });
  expect(messages.replyInput).toEqual({ conversation: event().conversation, text: "reply" });

  messages.replyOutcome = { status: "ambiguous" };
  expect(await transport.sendText(42, "reply")).toEqual({ disposition: "ambiguous" });
  messages.replyOutcome = { retryable: true, status: "failed" };
  expect(await transport.sendText(42, "reply")).toEqual({
    disposition: "failed",
    retrySafe: true,
  });
});

test("delivery and history require an observed exact conversation", async () => {
  const transport = new ImsgTransport(new FakeMessages());
  await expect(transport.sendText(42, "reply")).rejects.toThrow("scope is unavailable");
  await expect(transport.recentMessages(42)).rejects.toThrow("scope is unavailable");
});

test("delivery can resume from a persisted exact conversation reference", async () => {
  const messages = new FakeMessages();
  const transport = new ImsgTransport(messages);

  expect(await transport.sendText(42, "resumed reply", event().conversation)).toEqual({
    disposition: "confirmed",
    guid: "sent-guid",
  });
  expect(messages.replyInput).toEqual({
    conversation: event().conversation,
    text: "resumed reply",
  });
  await expect(transport.sendText(7, "wrong chat", event().conversation))
    .rejects.toThrow("scope is unavailable");
});

test("the iMessage channel speaks chat addresses without changing transport behavior", async () => {
  const messages = new FakeMessages();
  messages.events = [event()];
  const echoes: Array<{ chat: ChatAddress; text: string }> = [];
  const rows: number[] = [];
  const channel = new ImessageChannel(messages, {
    matchesOutboundEcho: (chat, text) => {
      echoes.push({ chat, text });
      return false;
    },
    onMessageRowId: (rowId) => { rows.push(rowId); },
  });
  const activations: ChannelActivation[] = [];
  const watch = await channel.watch({
    onActivation: (activation) => { activations.push(activation); },
    tags: ["@helper"],
  });
  await watch.close();

  expect(activations).toEqual([{
    activationTag: "@helper",
    chat: { channel: "imessage", id: "42" },
    conversation: event().conversation,
    isFromMe: false,
    providerGuid: "message-guid",
    request: "do this",
  }]);
  expect(rows).toEqual([101]);
  expect(echoes).toEqual([]);
  expect(await channel.sendText({ channel: "imessage", id: "42" }, "reply")).toEqual({
    disposition: "confirmed",
    guid: "sent-guid",
  });
  expect(messages.replyInput).toEqual({ conversation: event().conversation, text: "reply" });
  expect(channel.formatReply("@helper", "Done.")).toBe("Helper\nDone.");
  expect(await channel.currentChat.details({ channel: "imessage", id: "42" })).toEqual({
    owner_participated: true,
    provider: "apple-messages",
    service: "iMessage",
  });
  await expect(channel.sendText({ channel: "whatsapp", id: "42" }, "reply"))
    .rejects.toThrow("Invalid chat ID");
});

test("the iMessage channel checks its own echoes by chat address", () => {
  const messages = new FakeMessages();
  const seen: ChatAddress[] = [];
  const channel = new ImessageChannel(messages, {
    matchesOutboundEcho: (chat) => {
      seen.push(chat);
      return true;
    },
  });
  messages.events = [event({ fromMe: true, text: "@helper sent" })];
  return channel.watch({
    onActivation: () => { throw new Error("echo must not activate"); },
    tags: ["@helper"],
  }).then(async (watch) => {
    await watch.close();
    expect(seen).toEqual([{ channel: "imessage", id: "42" }]);
  });
});
