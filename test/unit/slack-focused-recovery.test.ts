import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createProntoSlack, type SlackBridge, type SlackBridgeEvent } from "../../packages/slack/src/index";
const now = 1_792_152_000_000;
const fresh = "1792152000.000001";
const old = "1700000000.000001";
const referenceKey = "synthetic-focused-slack-reference-key";
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "pronto-focused-slack-")); directories.push(directory);
  const calls: Array<{ operation: string; input: any }> = [];
  const overrides = new Map<string, (input: any) => any>();
  let listener = (_event: SlackBridgeEvent) => {};
  const bridge: SlackBridge = {
    async request(operation, input = {}) {
      calls.push({ operation, input });
      if (overrides.has(operation)) return overrides.get(operation)!(input);
      if (operation === "discover") return { workspaces: [{ team: "TTEST", label: "Synthetic", profile: "direct" }] };
      if (operation === "connect") return { team: "TTEST", owner: "UOWNER", label: "Synthetic", memberLabel: "Owner" };
      if (operation === "info") return { id: input.conversation, label: "Synthetic", type: "channel", supported: input.conversation !== "CEXTERNAL" };
      if (operation === "list") return { conversations: Array.from({ length: 500 }, (_, n) => ({ id: `C${n}`, label: "Bot feed", type: "channel", supported: true })), nextCursor: "" };
      return { messages: [], nextCursor: "", hasMore: false };
    }, listen(cb) { listener = cb; return () => {}; }, async close() {},
  };
  const provider = createProntoSlack({ directory, referenceKey, bridge, now: () => now });
  await provider.link((await provider.discover()).workspaces[0]!.handle); await provider.useParticipatedConversations();
  return { provider, bridge, directory, calls, overrides, emit: (event: SlackBridgeEvent) => listener(event) };
}
const message = (extra = {}) => ({ conversation: "COLD", ts: fresh, user: "UOWNER", text: "@test request", thread_ts: old, ...extra });

test("an idle workspace reads no channel history regardless of workspace size", async () => {
  const f = await fixture();
  try {
    await f.provider.qualify();
    const result = await f.provider.reconcile(async () => {}, ["@test"]);
    expect(result.status).toBe("recovered");
    expect(f.calls.filter((call) => ["list", "history", "replies", "participation"].includes(call.operation))).toEqual([]);
    expect(f.calls.filter((call) => call.operation === "tagged")).toHaveLength(1);
  } finally { await f.provider.close(); }
});

test("search finds a recent tag in an unseen old thread and canonical reads preserve its scope", async () => {
  const f = await fixture(); const observed: any[] = [];
  f.overrides.set("tagged", () => ({ messages: [message()], nextCursor: "" }));
  f.overrides.set("replies", (input) => ({ messages: input.oldest === fresh ? [message()] : [], nextCursor: "" }));
  try {
    const result = await f.provider.reconcile(async (event) => { observed.push(event); }, ["@test"]);
    expect(result.status).toBe("recovered"); expect(observed).toHaveLength(1);
    expect(observed[0].message.thread_ts).toBe(old);
    expect(f.calls.filter((call) => call.operation === "history")).toEqual([]);
    expect(f.calls.find((call) => call.operation === "replies")?.input).toMatchObject({ oldest: fresh, latest: fresh, thread: old });
    expect((await f.provider.reconcile(async () => { throw new Error("duplicate"); }, ["@test"])).messages).toBe(0);
  } finally { await f.provider.close(); }
});

test("non-owner tags need canonical positive participation and search results cannot grant it", async () => {
  const f = await fixture();
  const request = message({ user: "UOTHER" });
  f.overrides.set("participation", () => ({ messages: [message({ ts: old, thread_ts: undefined, user: "UOWNER", text: "Earlier message" })] }));
  f.overrides.set("history", () => ({ messages: [message({ ts: old, thread_ts: undefined, bot_id: "BBOT" })], nextCursor: "" }));
  try {
    expect(await f.provider.observe(request, "live")).toBeNull();
    f.overrides.set("history", () => ({ messages: [message({ ts: old, thread_ts: undefined, text: "Earlier message" })], nextCursor: "" }));
    expect(await f.provider.observe(request, "live")).not.toBeNull();
    expect(f.calls.filter((call) => call.operation === "history").every((call) => call.input.oldest === old && call.input.latest === old)).toBeTrue();
  } finally { await f.provider.close(); }
});

test("untagged socket traffic learns owner participation without admission or history reads", async () => {
  const f = await fixture(); const seen: any[] = [];
  const subscription = await f.provider.subscribe({ tags: () => ["@test"], isRequest: (text) => text.startsWith("@test"), onObservation: async (event) => { seen.push(event); } });
  try {
    f.emit({ event: "message", message: message({ text: "Ordinary owner message" }) });
    f.emit({ event: "message", message: message({ ts: "1792152000.000002", user: "UOTHER", text: "ordinary chatter" }) });
    await f.provider.refresh();
    expect(seen).toEqual([]);
    const state = JSON.parse(await readFile(join(f.directory, "state.json"), "utf8"));
    expect(state.seen).toEqual([]); expect(state.selections.find((row: any) => row.id === "COLD").participated).toBeTrue();
    expect(JSON.stringify(state)).not.toContain("Ordinary owner message");
    expect(f.calls.filter((call) => ["history", "replies", "participation"].includes(call.operation))).toEqual([]);
  } finally { await subscription.close(); await f.provider.close(); }
});

test("wake and restart find missed tags while keeping durable dedupe", async () => {
  const f = await fixture(); const seen: any[] = [];
  const subscription = await f.provider.subscribe({ tags: () => ["@test"], onObservation: async (event) => { seen.push(event); } });
  f.overrides.set("tagged", () => ({ messages: [message()], nextCursor: "" }));
  f.overrides.set("replies", () => ({ messages: [message()], nextCursor: "" }));
  try {
    f.emit({ event: "wake" }); await f.provider.refresh();
    expect(seen).toHaveLength(1);
    await subscription.close(); await f.provider.close();
    const restarted = createProntoSlack({ directory: f.directory, referenceKey, bridge: f.bridge, now: () => now });
    try { expect((await restarted.reconcile(async () => { throw new Error("duplicate"); }, ["@test"])).messages).toBe(0); }
    finally { await restarted.close(); }
  } finally { await f.provider.close(); }
});

test("search failures and bounded overflow are visible without starting an archive crawl", async () => {
  const f = await fixture();
  try {
    f.overrides.set("tagged", () => { throw new Error("unavailable"); });
    expect((await f.provider.reconcile(async () => {}, ["@test"])).status).toBe("degraded");
    f.overrides.set("tagged", () => ({ messages: [], nextCursor: "2" }));
    expect((await f.provider.reconcile(async () => {}, ["@test"])).status).toBe("degraded");
    expect(f.calls.filter((call) => call.operation === "tagged").length).toBeLessThanOrEqual(6);
    expect(f.calls.some((call) => ["history", "replies", "list"].includes(call.operation))).toBeFalse();
  } finally { await f.provider.close(); }
});

test("an admission failure stays unacknowledged and does not starve another conversation", async () => {
  const f = await fixture(); const seen: string[] = [];
  const requests = [message(), message({ conversation: "COTHER", ts: "1792152000.000002" })];
  f.overrides.set("tagged", () => ({ messages: requests, nextCursor: "" }));
  f.overrides.set("replies", (input) => ({ messages: requests.filter((row) => row.conversation === input.conversation), nextCursor: "" }));
  try {
    const first = await f.provider.reconcile(async (event) => { if (event.message.conversation === "COLD") throw new Error("admission failure"); seen.push(event.message.conversation); }, ["@test"]);
    expect(first.status).toBe("degraded"); expect(seen).toEqual(["COTHER"]);
    expect((await f.provider.reconcile(async (event) => { seen.push(event.message.conversation); }, ["@test"])).status).toBe("recovered");
    expect(seen).toEqual(["COTHER", "COLD"]);
  } finally { await f.provider.close(); }
});

test("the shared request cap includes canonical reads and participation lookups", async () => {
  const f = await fixture();
  f.overrides.set("tagged", () => ({ messages: Array.from({ length: 100 }, (_, n) => message({ conversation: `C${n}`, user: "UOTHER" })), nextCursor: "2" }));
  f.overrides.set("replies", () => ({ messages: [message({ user: "UOTHER" })], nextCursor: "" }));
  f.overrides.set("participation", () => ({ messages: [] }));
  try {
    const result = await f.provider.reconcile(async () => {}, ["@test"]);
    expect(result.status).toBe("degraded"); expect(result.requests).toBeLessThanOrEqual(50);
    expect(f.calls.filter((call) => ["tagged", "history", "replies", "info", "participation"].includes(call.operation))).toHaveLength(result.requests);
  } finally { await f.provider.close(); }
});

test("canonical edits, bots and unsupported destinations cannot become recovered requests", async () => {
  const f = await fixture(); const seen: any[] = [];
  f.overrides.set("tagged", () => ({ messages: [message(), message({ conversation: "CEXTERNAL" }), message({ conversation: "CBOT" })], nextCursor: "" }));
  f.overrides.set("replies", (input) => ({ messages: [message({ conversation: input.conversation, ...(input.conversation === "CBOT" ? { bot_id: "BBOT" } : { text: "tag was edited away" }) })], nextCursor: "" }));
  try {
    expect((await f.provider.reconcile(async (event) => { seen.push(event); }, ["@test"])).status).toBe("recovered");
    expect(seen).toEqual([]);
    expect(f.calls.some((call) => call.operation === "replies" && call.input.conversation === "CEXTERNAL")).toBeFalse();
  } finally { await f.provider.close(); }
});
