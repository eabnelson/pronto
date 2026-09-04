import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createProntoMessages, type MessagesEvent, type ProntoMessages } from "../src/index";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

interface TranscriptScenario {
  readonly chatGuid?: string;
  readonly chatIsGroup?: boolean;
  readonly event: Record<string, unknown>;
  readonly expectedFilePath?: string;
  readonly exitDuringSend?: boolean;
  readonly nearby?: readonly Record<string, unknown>[];
  readonly providerVersion?: string;
  readonly replaceDatabaseDuringHistory?: boolean;
  readonly sendError?: {
    readonly code: number;
    readonly data?: Record<string, unknown>;
    readonly message: string;
  };
  readonly sentMessages: number;
}

async function transcriptClient(scenario: TranscriptScenario): Promise<ProntoMessages> {
  const directory = await mkdtemp(join(tmpdir(), "pronto-messages-transcript-"));
  temporaryDirectories.push(directory);
  const transcript = join(directory, "imsg-transcript");
  const databasePath = join(directory, "chat.db");
  await writeFile(databasePath, "synthetic database evidence", { mode: 0o600 });
  const fixture = { ...scenario, databasePath };
  await writeFile(transcript, `#!/usr/bin/env bun
const scenario = ${JSON.stringify(fixture)};
const decoder = new TextDecoder();
let buffer = "";
for await (const chunk of Bun.stdin.stream()) {
  buffer += decoder.decode(chunk, { stream: true });
  while (buffer.includes("\\n")) {
    const newline = buffer.indexOf("\\n");
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (line.trim() === "") continue;
    const request = JSON.parse(line);
    let result;
    if (request.method === "initialize") {
      result = {
        protocol_version: 1,
        version: scenario.providerVersion ?? "0.14.1",
        database: { path: scenario.databasePath, ready: true, features: { routing_metadata: true } },
        methods: ["initialize", "status", "chats.list", "messages.history", "messages.after", "messages.stats", "watch.subscribe", "watch.unsubscribe", "send"],
      };
    } else if (request.method === "watch.subscribe") {
      result = { subscription: 7 };
    } else if (request.method === "chats.list") {
      result = {
        chats: [{
          account_id: "E:owner@example.com",
          account_login: "owner@example.com",
          guid: scenario.chatGuid ?? "iMessage;-;+15550000000",
          id: 42,
          is_group: scenario.chatIsGroup ?? false,
          last_addressed_handle: "+15551111111",
          service: "iMessage",
        }],
      };
    } else if (request.method === "messages.history") {
      if (scenario.replaceDatabaseDuringHistory === true) {
        const replacement = scenario.databasePath + ".replacement";
        await Bun.write(replacement, "replacement database evidence");
        await import("node:fs/promises").then(({ rename }) =>
          rename(replacement, scenario.databasePath));
      }
      result = { messages: [scenario.event] };
    } else if (request.method === "messages.stats") {
      result = {
        chats: [{ chat_id: 42, service: "iMessage" }],
        sent_messages: scenario.sentMessages,
      };
    } else if (request.method === "messages.after") {
      result = { messages: scenario.nearby ?? [] };
    } else if (request.method === "send") {
      if (request.params.chat_id !== 42) throw new Error("reply was not exactly routed");
      if (scenario.expectedFilePath !== undefined &&
          request.params.file !== scenario.expectedFilePath) {
        throw new Error("reply attachment was not preserved");
      }
      if (scenario.exitDuringSend === true) process.exit(0);
      if (scenario.sendError !== undefined) {
        process.stdout.write(JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          error: scenario.sendError,
        }) + "\\n");
        continue;
      }
      result = { ok: true, guid: "outbound-guid" };
    } else {
      result = { ok: true };
    }
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");
    if (request.method === "watch.subscribe") {
      process.stdout.write(JSON.stringify({
        jsonrpc: "2.0",
        method: "message",
        params: { subscription: 7, message: scenario.event },
      }) + "\\n");
    }
  }
}
`, { mode: 0o700 });
  await chmod(transcript, 0o700);
  return createProntoMessages({
    imsgPath: transcript,
    recoveryLimits: { maxLiveAgeMs: Number.MAX_SAFE_INTEGER },
  });
}

async function nextEvent(messages: ProntoMessages): Promise<MessagesEvent> {
  let resolveEvent!: (event: MessagesEvent) => void;
  const eventPromise = new Promise<MessagesEvent>((resolve) => {
    resolveEvent = resolve;
  });
  const subscriptionPromise = messages.subscribe({ onEvent: resolveEvent });
  const [event, subscription] = await Promise.all([eventPromise, subscriptionPromise]);
  await subscription.close();
  return event;
}

const inboundEvent = {
  chat_id: 42,
  date: "2026-09-01T12:00:00.000Z",
  guid: "inbound-guid",
  id: 101,
  is_from_me: false,
  is_group: false,
  chat_guid: "iMessage;-;+15550000000",
  destination_caller_id: "+15551111111",
  participants: ["+15550000000", "+15551111111"],
  sender: "+15550000000",
  service: "iMessage",
  text: "hello from Messages",
};

test("normalizes one imsg 0.15 transcript event and replies to its exact conversation", async () => {
  const messages = await transcriptClient({
    event: inboundEvent,
    providerVersion: "0.15.0",
    sentMessages: 3,
  });
  const qualification = await messages.qualify();
  expect(qualification).toMatchObject({ providerVersion: "0.15.0", status: "ready" });

  const event = await nextEvent(messages);
  expect(event).toEqual({
    conversation: {
      chatId: 42,
      expiresAt: expect.any(String),
      provider: "apple-messages",
      token: expect.any(String),
      version: 1,
    },
    conversationFacts: {
      ownerParticipated: true,
      routing: {
        accountId: "E:owner@example.com",
        accountLogin: "owner@example.com",
        conversationId: "iMessage;-;+15550000000",
        destinationHandle: "+15551111111",
        isGroup: false,
        label: null,
        participants: ["+15550000000", "+15551111111"],
      },
      service: "iMessage",
    },
    message: {
      attachments: [],
      destinationCallerId: "+15551111111",
      fromMe: false,
      kind: "message",
      occurredAt: "2026-09-01T12:00:00.000Z",
      providerMessageId: "inbound-guid",
      reaction: null,
      rowId: 101,
      replyToProviderMessageId: null,
      replyToText: null,
      sender: "+15550000000",
      selfChatMirror: false,
      service: "iMessage",
      text: "hello from Messages",
      urlPreview: false,
    },
    provider: "apple-messages",
    version: 1,
  });
  expect(await messages.reply({ conversation: event.conversation, text: "hello back" })).toEqual({
    providerMessageId: "outbound-guid",
    status: "confirmed",
  });
  await messages.close();
});

test("resolves one exact known conversation and preserves one outbound attachment", async () => {
  const filePath = "/private/tmp/staged-report.pdf";
  const messages = await transcriptClient({
    event: inboundEvent,
    expectedFilePath: filePath,
    sentMessages: 3,
  });
  const resolved = await messages.resolveConversation({
    accountId: "E:owner@example.com",
    conversationId: "iMessage;-;+15550000000",
  });
  expect(resolved?.facts.routing).toMatchObject({
    accountId: "E:owner@example.com",
    conversationId: "iMessage;-;+15550000000",
  });
  expect(await messages.reply({
    conversation: resolved!.conversation,
    filePath,
    text: "report attached",
  })).toEqual({ providerMessageId: "outbound-guid", status: "confirmed" });
  expect(await messages.reply({
    conversation: resolved!.conversation,
    filePath: "relative/report.pdf",
    text: "unsafe path",
  })).toEqual({ retryable: false, status: "failed" });
  expect(await messages.resolveConversation({
    accountId: "E:other@example.com",
    conversationId: "iMessage;-;+15550000000",
  })).toBeNull();
  await messages.close();
});

test("does not issue a conversation reference across database generations", async () => {
  const messages = await transcriptClient({
    event: inboundEvent,
    replaceDatabaseDuringHistory: true,
    sentMessages: 3,
  });
  expect(await messages.resolveConversation({
    accountId: "E:owner@example.com",
    conversationId: "iMessage;-;+15550000000",
  })).toBeNull();
  await messages.close();
});

test("reports owner-absent conversations as normalized provider facts", async () => {
  const messages = await transcriptClient({ event: inboundEvent, sentMessages: 0 });
  expect((await nextEvent(messages)).conversationFacts.ownerParticipated).toBeFalse();
  await messages.close();
});

test("withholds routing when the conversation GUID contradicts group flags", async () => {
  const groupShapedGuid = "iMessage;+;chat123456789";
  const messages = await transcriptClient({
    chatGuid: groupShapedGuid,
    chatIsGroup: false,
    event: {
      ...inboundEvent,
      chat_guid: groupShapedGuid,
      is_group: false,
    },
    sentMessages: 1,
  });
  expect((await nextEvent(messages)).conversationFacts.routing).toBeUndefined();
  await messages.close();
});

test("marks a provider mirror by correlating nearby outbound history", async () => {
  const messages = await transcriptClient({
    event: {
      ...inboundEvent,
      reply_to_guid: "outgoing-guid",
      reply_to_text: "hello from Messages",
    },
    nearby: [{
      ...inboundEvent,
      date: "2026-09-01T12:00:00.500Z",
      guid: "outgoing-guid",
      id: 100,
      is_from_me: true,
    }],
    sentMessages: 1,
  });
  expect((await nextEvent(messages)).message.selfChatMirror).toBeTrue();
  await messages.close();
});

test("classifies a process failure after send submission as ambiguous without replay", async () => {
  const messages = await transcriptClient({
    event: inboundEvent,
    exitDuringSend: true,
    sentMessages: 1,
  });
  const event = await nextEvent(messages);
  expect(await messages.reply({
    conversation: event.conversation,
    text: "one external effect",
  })).toEqual({ status: "ambiguous" });
  await messages.close();
});

test("preserves provider retryability without treating uncertain sends as retryable", async () => {
  const availabilityFailure = await transcriptClient({
    event: inboundEvent,
    sendError: {
      code: -32_002,
      data: { retryable: true },
      message: "Messages database is unavailable",
    },
    sentMessages: 1,
  });
  const availabilityEvent = await nextEvent(availabilityFailure);
  expect(await availabilityFailure.reply({
    conversation: availabilityEvent.conversation,
    text: "retry after recovery",
  })).toEqual({ retryable: true, status: "failed" });
  await availabilityFailure.close();

  const uncertainFailure = await transcriptClient({
    event: inboundEvent,
    sendError: {
      code: -32_004,
      data: { disposition: "may_have_completed", retry_safe: false },
      message: "delivery could not be verified",
    },
    sentMessages: 1,
  });
  const uncertainEvent = await nextEvent(uncertainFailure);
  expect(await uncertainFailure.reply({
    conversation: uncertainEvent.conversation,
    text: "do not replay",
  })).toEqual({ status: "ambiguous" });
  await uncertainFailure.close();
});
