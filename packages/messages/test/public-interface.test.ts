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
  readonly event: Record<string, unknown>;
  readonly exitDuringSend?: boolean;
  readonly nearby?: readonly Record<string, unknown>[];
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
        version: "0.14.1",
        database: { path: scenario.databasePath, ready: true, features: { routing_metadata: true } },
        methods: ["initialize", "status", "chats.list", "messages.history", "messages.after", "messages.stats", "watch.subscribe", "watch.unsubscribe", "send"],
      };
    } else if (request.method === "watch.subscribe") {
      result = { subscription: 7 };
    } else if (request.method === "messages.stats") {
      result = {
        chats: [{ chat_id: 42, service: "iMessage" }],
        sent_messages: scenario.sentMessages,
      };
    } else if (request.method === "messages.after") {
      result = { messages: scenario.nearby ?? [] };
    } else if (request.method === "send") {
      if (request.params.chat_id !== 42) throw new Error("reply was not exactly routed");
      if (scenario.exitDuringSend === true) process.exit(0);
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
  return createProntoMessages({ imsgPath: transcript });
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
  sender: "+15550000000",
  service: "iMessage",
  text: "hello from Messages",
};

test("normalizes one inbound transcript event and replies to its exact conversation", async () => {
  const messages = await transcriptClient({ event: inboundEvent, sentMessages: 3 });
  const qualification = await messages.qualify();
  expect(qualification).toMatchObject({ providerVersion: "0.14.1", status: "ready" });

  const event = await nextEvent(messages);
  expect(event).toEqual({
    conversation: { chatId: 42, provider: "apple-messages", version: 1 },
    conversationFacts: { ownerParticipated: true, service: "iMessage" },
    message: {
      attachments: [],
      fromMe: false,
      kind: "message",
      occurredAt: "2026-09-01T12:00:00.000Z",
      providerMessageId: "inbound-guid",
      rowId: 101,
      replyToProviderMessageId: null,
      replyToText: null,
      sender: "+15550000000",
      selfChatMirror: false,
      service: "iMessage",
      text: "hello from Messages",
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

test("reports owner-absent conversations as normalized provider facts", async () => {
  const messages = await transcriptClient({ event: inboundEvent, sentMessages: 0 });
  expect((await nextEvent(messages)).conversationFacts.ownerParticipated).toBeFalse();
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
  expect(await messages.reply({
    conversation: { chatId: 42, provider: "apple-messages", version: 1 },
    text: "one external effect",
  })).toEqual({ status: "ambiguous" });
  await messages.close();
});
