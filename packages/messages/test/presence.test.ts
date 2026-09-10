import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProntoMessages } from "../src/index";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function fixture(options: {
  enabled?: boolean;
  ready?: boolean;
  wrongTarget?: boolean;
  mutationError?: Record<string, unknown>;
  mutationDelayMs?: number;
  routeChanges?: boolean;
  typingAvailable?: boolean;
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), "pronto-presence-"));
  const database = join(directory, "chat.db");
  const log = join(directory, "requests.jsonl");
  const command = join(directory, "imsg");
  await writeFile(database, "synthetic database");
  await writeFile(log, "");
  await writeFile(command, `#!/usr/bin/env bun
import { appendFile } from "node:fs/promises";
const options = ${JSON.stringify(options)};
const log = ${JSON.stringify(log)};
const message = { id: 101, guid: "tag-guid", chat_id: 42,
  chat_guid: "iMessage;-;+15550000000", is_group: false,
  participants: ["+15550000000"], service: "iMessage" };
let chatReads = 0;
for await (const line of console) {
  const request = JSON.parse(line);
  await appendFile(log, JSON.stringify(request) + "\\n");
  let result = { ok: true };
  if (["initialize", "status"].includes(request.method)) result = {
    protocol_version: 1, version: "0.15.0",
    database: { path: ${JSON.stringify(database)}, ready: true, features: { routing_metadata: true } },
    bridge: { ready: options.ready !== false, v2_ready: true, registry_available: true,
      selectors: { sendReaction: true, typing: options.typingAvailable !== false } },
    methods: ["initialize", "status", "chats.list", "messages.history", "messages.after",
      "messages.stats", "watch.subscribe", "watch.unsubscribe", "send", "tapback", "typing"]
  };
  if (request.method === "chats.list") result = { chats: [{ id: 42,
    guid: message.chat_guid, account_id: "account-one", account_login: "owner@example.com",
    last_addressed_handle: options.routeChanges && ++chatReads > 1 ? "+15552222222" : "+15551111111",
    service: "iMessage", is_group: false }] };
  if (request.method === "messages.history") result = { messages: [message] };
  if (request.method === "messages.after") result = { messages: [{ ...message,
    guid: options.wrongTarget ? "other-guid" : message.guid }] };
  if (request.method === "messages.stats") result = {
    sent_messages: 2, chats: [{ chat_id: 42, service: "iMessage" }] };
  if (request.method === "send") result = { ok: true, guid: "reply-guid" };
  const error = ["tapback", "typing"].includes(request.method) ? options.mutationError : undefined;
  if (["tapback", "typing"].includes(request.method) && options.mutationDelayMs) {
    await Bun.sleep(options.mutationDelayMs);
  }
  process.stdout.write(JSON.stringify({ id: request.id, jsonrpc: "2.0",
    ...(error ? { error } : { result }) }) + "\\n");
}
`, { mode: 0o700 });
  const messages = createProntoMessages({ imsgPath: command, presence: options.enabled ?? true });
  cleanups.push(async () => { await messages.close(); await rm(directory, { recursive: true, force: true }); });
  const resolved = await messages.resolveConversation({
    accountId: "account-one", conversationId: "iMessage;-;+15550000000",
  });
  if (resolved === null) throw new Error("fixture conversation missing");
  return {
    messages,
    conversation: resolved.conversation,
    requests: async () => (await readFile(log, "utf8")).trim().split("\n").filter(Boolean)
      .map((line) => JSON.parse(line) as { method: string; params: Record<string, unknown> }),
  };
}

test("reacts to the exact observed tag while ordinary replies remain usable", async () => {
  const { messages, conversation, requests } = await fixture();
  expect(await messages.presence!.react({
    conversation, target: { providerMessageId: "tag-guid", rowId: 101 }, reaction: "like",
  })).toEqual({ status: "accepted" });
  expect((await requests()).filter(({ method }) => method === "tapback")).toMatchObject([
    { method: "tapback", params: { chat_id: 42, message_guid: "tag-guid", reaction: "like", part_index: 0 } },
  ]);
  expect(await messages.reply({ conversation, text: "Done" })).toMatchObject({ status: "confirmed" });
});

test("disabled or unavailable bridge never mutates even when typing is advertised", async () => {
  for (const options of [{ enabled: false }, { ready: false }]) {
    const { messages, conversation, requests } = await fixture(options);
    expect(await messages.presence!.setTyping({ conversation, typing: true }))
      .toEqual({ status: "unavailable" });
    expect((await requests()).filter(({ method }) => ["tapback", "typing"].includes(method)))
      .toEqual([]);
  }
});

test("rejects a target outside the observed conversation and unsupported emoji", async () => {
  const { messages, conversation, requests } = await fixture({ wrongTarget: true });
  expect(await messages.presence!.react({
    conversation, target: { providerMessageId: "tag-guid", rowId: 101 }, reaction: "like",
  })).toEqual({ status: "failed", retryable: false });
  expect(await messages.presence!.react({
    conversation, target: { providerMessageId: "tag-guid", rowId: 101 }, reaction: "👀" as never,
  })).toEqual({ status: "failed", retryable: false });
  expect((await requests()).filter(({ method }) => method === "tapback")).toEqual([]);
});

test("suspends uncertain presence mutations without disabling ordinary replies", async () => {
  const { messages, conversation, requests } = await fixture({ mutationError: {
    code: -32001, message: "uncertain", data: { disposition: "still_in_flight", retry_safe: false },
  } });
  expect(await messages.presence!.setTyping({ conversation, typing: true }))
    .toEqual({ status: "ambiguous" });
  expect(await messages.presence!.status()).toMatchObject({ reason: "mutation_uncertain", typing: false });
  expect(await messages.presence!.setTyping({ conversation, typing: false }))
    .toEqual({ status: "unavailable" });
  expect((await requests()).filter(({ method }) => method === "typing")).toHaveLength(1);
  expect(await messages.reply({ conversation, text: "Still replying" })).toMatchObject({ status: "confirmed" });
});

test("starts and stops typing in the exact observed conversation", async () => {
  const { messages, conversation, requests } = await fixture();
  expect(await messages.presence!.setTyping({ conversation, typing: true })).toEqual({ status: "accepted" });
  expect(await messages.presence!.setTyping({ conversation, typing: false })).toEqual({ status: "accepted" });
  expect((await requests()).filter(({ method }) => method === "typing")).toMatchObject([
    { params: { chat_id: 42, typing: true } }, { params: { chat_id: 42, typing: false } },
  ]);
});

test("a timed-out presence process cannot stall or retry an ordinary reply", async () => {
  const { messages, conversation, requests } = await fixture({ mutationDelayMs: 2_500 });
  const pending = messages.presence!.setTyping({ conversation, typing: true });
  for (let tries = 0; tries < 200; tries++) {
    if ((await requests()).some(({ method }) => method === "typing")) break;
    await Bun.sleep(5);
  }
  expect((await requests()).some(({ method }) => method === "typing")).toBe(true);
  expect(await messages.reply({ conversation, text: "Reply while typing is stuck" }))
    .toMatchObject({ status: "confirmed" });
  expect(await pending).toEqual({ status: "ambiguous" });
  expect(await messages.presence!.setTyping({ conversation, typing: false }))
    .toEqual({ status: "unavailable" });
  expect((await requests()).filter(({ method }) => method === "typing")).toHaveLength(1);
});

test("a changed route invalidates the observed conversation before presence dispatch", async () => {
  const { messages, conversation, requests } = await fixture({ routeChanges: true });
  expect(await messages.presence!.react({ conversation,
    target: { providerMessageId: "tag-guid", rowId: 101 }, reaction: "like" }))
    .toEqual({ status: "failed", retryable: false });
  expect((await requests()).filter(({ method }) => method === "tapback")).toEqual([]);
});

test("readiness distinguishes a missing selector from an available reaction capability", async () => {
  const { messages, conversation, requests } = await fixture({ typingAvailable: false });
  expect(await messages.presence!.status())
    .toEqual({ reactions: true, typing: false, reason: "bridge_unavailable" });
  expect(await messages.presence!.setTyping({ conversation, typing: true }))
    .toEqual({ status: "unavailable" });
  expect((await requests()).filter(({ method }) => method === "typing")).toEqual([]);
});
