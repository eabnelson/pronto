import { expect, test } from "bun:test";
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
