import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProntoSlack, type SlackBridge } from "../../packages/slack/src/index";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "pronto-slack-test-"));
  directories.push(directory);
  const overrides = new Map<string, (input: any) => any>();
  const calls: Array<{ operation: string; input: any }> = [];
  let listener: (event: any) => void = () => {};
  const bridge: SlackBridge = {
    async request(operation, input = {}) {
      calls.push({ operation, input });
      if (overrides.has(operation)) return overrides.get(operation)!(input);
      if (operation === "discover") return { workspaces: [{ team: "TFIXTURE", label: "Synthetic workspace", profile: "direct" }] };
      if (operation === "connect") return { team: "TFIXTURE", owner: "UFIXTURE", label: "Synthetic workspace", memberLabel: "Synthetic owner" };
      if (operation === "list") return { conversations: [
        { id: "DFIXTURE", label: "Synthetic self DM", type: "self", supported: true },
        { id: "CFIXTURE", label: "Synthetic channel", type: "channel", supported: true },
        { id: "CEXTERNAL", label: "Synthetic shared channel", type: "channel", supported: false },
      ], nextCursor: "" };
      if (operation === "info") return { id: input.conversation, label: "Synthetic conversation", type: String(input.conversation).startsWith("D") ? "self" : "channel", supported: input.conversation !== "CEXTERNAL" };
      return { messages: [], nextCursor: "", outcome: "confirmed", ts: "1792152001.000001" };
    },
    listen(callback) { listener = callback; return () => { listener = () => {}; }; },
    async close() {},
  };
  let now = 1_792_152_000_000;
  const provider = createProntoSlack({ directory, referenceKey: "fixture-reference-key-32-characters-long", bridge, now: () => now });
  return { directory, calls, overrides, bridge, provider, emit: (event: any) => listener(event), advance: (ms: number) => { now += ms; } };
}

test("discovery is metadata only; link starts with no authorized conversations", async () => {
  const f = await fixture();
  const discovery = await f.provider.discover();
  expect(JSON.stringify(discovery)).not.toContain("TFIXTURE");
  expect(discovery.workspaces[0]?.handle).toBeTruthy();
  await f.provider.link(discovery.workspaces[0]!.handle);
  expect((await f.provider.qualify()).degraded).toEqual(["slack-selection-required"]);
  expect(f.calls.some(({ operation }) => operation === "history" || operation === "send")).toBe(false);
  await f.provider.close();
});

test("selection validates atomically, expires handles, and revokes old scopes on removal", async () => {
  const f = await fixture();
  await f.provider.link((await f.provider.discover()).workspaces[0]!.handle);
  const rows = (await f.provider.conversations()).conversations;
  await expect(f.provider.select([rows[0]!.handle, rows[2]!.handle])).rejects.toThrow("slack-conversation-unsupported");
  expect((await f.provider.conversations()).conversations.every((row) => !row.selected)).toBe(true);
  await f.provider.select([rows[0]!.handle]);
  const reference = await f.provider.observe({ conversation: "DFIXTURE", ts: "1792152000.000001", user: "UFIXTURE", text: "synthetic request" }, "live");
  expect(reference?.scope.id).toBeTruthy();
  await f.provider.select([]);
  await expect(f.provider.history(reference!.scope, 10)).rejects.toThrow("slack-scope-revoked");
  f.advance(600_001);
  await expect(f.provider.select([rows[1]!.handle])).rejects.toThrow("slack-handle-expired");
});

async function linked() {
  const f = await fixture();
  await f.provider.link((await f.provider.discover()).workspaces[0]!.handle);
  const rows = (await f.provider.conversations()).conversations;
  await f.provider.select([rows[0]!.handle, rows[1]!.handle]);
  return f;
}

test("DM root metadata stays in the timeline; real replies and channel roots get isolated scopes", async () => {
  const f = await linked();
  const base = { conversation: "DFIXTURE", ts: "1792152000.000001", user: "UFIXTURE", text: "@pronto request" };
  const root = await f.provider.observe({ ...base, thread_ts: base.ts }, "live");
  const timeline = await f.provider.observe({ ...base, ts: "1792152000.000002" }, "live");
  const thread = await f.provider.observe({ ...base, ts: "1792152000.000003", thread_ts: base.ts }, "live");
  const channelRoot = await f.provider.observe({ ...base, conversation: "CFIXTURE" }, "live");
  const channelReply = await f.provider.observe({ ...base, conversation: "CFIXTURE", ts: "1792152000.000004", thread_ts: base.ts }, "live");
  expect(root!.scope.id).toBe(timeline!.scope.id);
  expect(thread!.scope.id).not.toBe(root!.scope.id);
  expect(channelRoot!.scope.id).toBe(channelReply!.scope.id);
  await f.provider.acknowledgeObservation(root!);
  expect(await f.provider.observe(base, "recovered")).toBeNull();
  await f.provider.close();
});

test("owner participation is positive evidence; subtypes, bots, future and unselected messages fail closed", async () => {
  const f = await linked();
  const base = { conversation: "DFIXTURE", ts: "1792152000.000001", user: "UOTHER", text: "@pronto request" };
  expect(await f.provider.observe(base, "live")).toBeNull();
  expect(await f.provider.observe({ ...base, user: "UFIXTURE" }, "live")).not.toBeNull();
  expect(await f.provider.observe({ ...base, ts: "1792152000.000002" }, "live")).not.toBeNull();
  for (const extra of [{ subtype: "message_changed" }, { bot_id: "BBOT" }, { app_id: "AAPP" }, { conversation: "DUNSELECTED" }, { ts: "1792152999.000001" }]) expect(await f.provider.observe({ ...base, ...extra }, "live")).toBeNull();
});

test("lost send response is ambiguous without retry; exact outbound identity suppresses fast echoes", async () => {
  const f = await linked();
  const event = await f.provider.observe({ conversation: "DFIXTURE", ts: "1792152000.000001", user: "UFIXTURE", text: "@pronto source" }, "live");
  let echo: Promise<any> | undefined;
  f.overrides.set("send", async (input) => {
    echo = f.provider.observe({ conversation: "DFIXTURE", ts: "1792152000.000004", user: "UFIXTURE", text: input.text, client_msg_id: input.clientMessageId }, "live");
    throw new Error("synthetic response loss");
  });
  expect(await f.provider.reply(event!.scope, "Pronto\n@pronto output")).toEqual({ disposition: "ambiguous" });
  expect(await echo).toBeNull();
  expect(f.calls.filter(({ operation }) => operation === "send")).toHaveLength(1);
  // Same text by a human is not identity proof of an outbound echo.
  expect(await f.provider.observe({ conversation: "DFIXTURE", ts: "1792152000.000005", user: "UFIXTURE", text: "Pronto\n@pronto output" }, "live")).not.toBeNull();
});

test("sealed scopes expire and cannot cross installations, relinks, or conversation reselection", async () => {
  const f = await linked(); const other = await linked();
  const event = await f.provider.observe({ conversation: "DFIXTURE", ts: "1792152000.000001", user: "UFIXTURE", text: "@pronto request" }, "live");
  expect(await other.provider.authorized(event!.scope)).toBe(false);
  const forged = { ...event!.scope, id: "forged" };
  expect(await f.provider.authorized(forged)).toBe(false);
  await f.provider.unlink(); expect(await f.provider.authorized(event!.scope)).toBe(false);
  await f.provider.link((await f.provider.discover()).workspaces[0]!.handle);
  expect(await f.provider.authorized(event!.scope)).toBe(false);
});

test("thread context retains a bounded root with newest replies within the shared context budget", async () => {
  const f = await linked();
  const observed = await f.provider.observe({ conversation: "CFIXTURE", ts: "1792152000.000001", user: "UFIXTURE", text: "@pronto request" }, "live");
  f.overrides.set("replies", () => ({ messages: [{ conversation: "CFIXTURE", ts: "1792152000.000001", user: "UFIXTURE", text: "ROOT-EVIDENCE" + "x".repeat(20_000) }, ...Array.from({ length: 40 }, (_, i) => ({ conversation: "CFIXTURE", ts: `1792152000.${String(i + 2).padStart(6, "0")}`, user: "UOTHER", text: `reply-${i}` + "y".repeat(2_000) }))], nextCursor: "" }));
  const messages = await f.provider.history(observed!.scope, 30);
  expect(messages[0]!.text).toContain("ROOT-EVIDENCE");
  expect(messages[0]!.text).toContain("truncated");
  expect(messages.at(-1)!.text).toContain("reply-39");
  expect(JSON.stringify(messages).length).toBeLessThan(12_000);
  expect(f.calls.filter(({ operation }) => operation === "history")).toHaveLength(0);
});

test("a running broker capability cannot inherit new authority when the same memory scope relinks", async () => {
  const { SlackChannel } = await import("../../packages/cli/src/slack/channel");
  const { ConversationBroker } = await import("../../packages/cli/src/tools/broker");
  const f = await linked();
  const first = await f.provider.observe({ conversation: "DFIXTURE", ts: "1792152000.000001", user: "UFIXTURE", text: "@pronto request" }, "live");
  const channel = new SlackChannel(f.provider); const broker = new ConversationBroker(channel.currentChat);
  const chat = { channel: "slack" as const, id: first!.scope.id };
  await channel.recentMessages(chat, 10, first!.scope);
  const capability = broker.issue(chat, first!.scope);
  await broker.query(capability.token, "current_chat_details", {});
  await f.provider.unlink();
  await f.provider.link((await f.provider.discover()).workspaces[0]!.handle);
  await f.provider.select([(await f.provider.conversations()).conversations[0]!.handle]);
  const next = await f.provider.observe({ conversation: "DFIXTURE", ts: "1792152000.000002", user: "UFIXTURE", text: "@pronto next" }, "live");
  expect(next!.scope.id).toBe(chat.id);
  await channel.recentMessages(chat, 10, next!.scope);
  await expect(broker.query(capability.token, "current_chat_details", {})).rejects.toThrow("slack-scope-revoked");
});

test("canonical duplicate handles count once and a linked member cannot silently change", async () => {
  const f = await linked();
  const one = (await f.provider.conversations()).conversations[0]!;
  const two = (await f.provider.conversations()).conversations[0]!;
  expect(await f.provider.select([one.handle, one.handle, two.handle])).toEqual({ selected: 1 });
  f.overrides.set("connect", () => ({ team: "TFIXTURE", owner: "UDIFFERENT", label: "Synthetic workspace", memberLabel: "Other synthetic member" }));
  const workspace = (await f.provider.discover()).workspaces[0]!;
  await expect(f.provider.link(workspace.handle)).rejects.toThrow("slack-identity-mismatch");
  expect((await f.provider.qualify()).status).toBe("needs_link");
  expect(f.calls.at(-1)?.input.interactive).toBe(false);
});

test("settings reload reconciles empty selection and unlink without restarting the product daemon", async () => {
  const f = await linked(); const recoveries: any[] = []; const health: any[] = [];
  const subscription = await f.provider.subscribe({ onObservation: async () => {}, onRecovery: (value) => { recoveries.push(value); }, onHealth: (value) => { health.push(value); } });
  try {
    await f.provider.select([]); await f.provider.refresh();
    expect(recoveries.at(-1).reason).toBe("slack-selection-required");
    await f.provider.select([(await f.provider.conversations()).conversations[0]!.handle]); await f.provider.refresh();
    expect(recoveries.at(-1).status).toBe("recovered");
    await f.provider.unlink(); await f.provider.refresh();
    expect(health.at(-1).state).toBe("needs_link");
    expect(f.calls.some((call) => call.operation === "unwatch" && call.input.clearSession === true)).toBe(true);
  } finally { await subscription.close(); await f.provider.close(); }
});

test("a new provider process replays unacknowledged work and retains durable dedupe", async () => {
  const f = await linked();
  const message = { conversation: "DFIXTURE", ts: "1792152000.000001", user: "UFIXTURE", text: "@pronto synthetic pending request" };
  const pending = await f.provider.observe(message, "live");
  const bridge = f.bridge;
  await f.provider.close();
  const next = createProntoSlack({ directory: f.directory, referenceKey: "fixture-reference-key-32-characters-long", bridge, now: () => 1_792_152_000_000 });
  expect(await next.authorized(pending!.scope)).toBe(true);
  const replay = await next.observe(message, "recovered"); expect(replay).not.toBeNull();
  await next.acknowledgeObservation(replay!);
  const restarted = createProntoSlack({ directory: f.directory, referenceKey: "fixture-reference-key-32-characters-long", bridge, now: () => 1_792_152_000_000 });
  expect(await restarted.observe(message, "recovered")).toBeNull();
  await next.close(); await restarted.close();
});
