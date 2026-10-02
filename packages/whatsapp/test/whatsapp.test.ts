import { setDefaultTimeout, afterEach, expect, test } from "bun:test";
import { readFile, stat, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createProntoWhatsapp, WhatsappAttachmentExpiredError, type WhatsappEvent, type WhatsappHealth, type WhatsappLinkStep, type WhatsappRecoveryOutcome } from "../src/index";
import {
  ALICE,
  BOB,
  FAKE_WACLI,
  GROUP,
  LINKED,
  OWNER,
  REFERENCE_KEY,
  cleanupAll,
  iso,
  row,
  setup,
  waitFor,
  webhook,
} from "./harness";

// Each wacli call starts a fake Bun process, which is slow on a busy machine.
setDefaultTimeout(30_000);

afterEach(cleanupAll);

function collector() {
  const events: WhatsappEvent[] = [];
  const health: WhatsappHealth[] = [];
  const recovery: WhatsappRecoveryOutcome[] = [];
  return {
    events,
    health,
    input: {
      onEvent: (event: WhatsappEvent) => {
        events.push(event);
      },
      onHealth: (value: WhatsappHealth) => {
        health.push(value);
      },
      onRecovery: (value: WhatsappRecoveryOutcome) => {
        recovery.push(value);
      },
    },
    recovery,
  };
}

async function seedState(statePath: string, watermark: string, delivered: string[] = []): Promise<void> {
  await mkdir(dirname(statePath), { recursive: true });
  await writeFile(statePath, JSON.stringify({ delivered, undelivered: [], version: 1, watermark }));
}

test("options are validated", () => {
  const base = { referenceKey: REFERENCE_KEY, statePath: "/tmp/s.json", storeDir: "/tmp/store", wacliPath: FAKE_WACLI };
  expect(() => createProntoWhatsapp({ ...base, referenceKey: "short" })).toThrow(/at least 32/);
  expect(() => createProntoWhatsapp({ ...base, storeDir: "relative" })).toThrow(/absolute/);
  expect(createProntoWhatsapp(base).presence).toBeUndefined();
  expect(createProntoWhatsapp({ ...base, presence: true }).presence).toBeDefined();
});

test("qualify enforces the wacli version floor and reports link state", async () => {
  // `wacli version` takes no --store, so an older binary is simulated with a wrapper.
  const old = await setup({ auth: LINKED });
  const wrapper = join(old.dir, "old-wacli");
  await writeFile(wrapper, `#!/bin/sh\nif [ "$1" = version ]; then echo 0.18.2; exit 0; fi\nexec "${FAKE_WACLI}" "$@"\n`, { mode: 0o755 });
  await expect(old.newModule({ wacliPath: wrapper }).qualify())
    .rejects.toThrow(/0\.18\.2 is older than the required 0\.19\.0/);

  const linked = await setup({ auth: LINKED });
  expect(await linked.module.qualify()).toEqual({ linkedJid: OWNER, status: "ready", wacliVersion: "0.19.0" });
  expect((await stat(linked.store)).mode & 0o777).toBe(0o700);

  const unlinked = await setup({ auth: { authenticated: false } });
  expect(await unlinked.module.qualify()).toEqual({ status: "needs_link", wacliVersion: "0.19.0" });
});

test("subscribe verifies signatures, normalizes events, and drops excluded chats", async () => {
  const h = await setup({
    auth: LINKED,
    messages: [row({ chat: GROUP, fromMe: true, id: "OLD", ts: iso(3 * 24 * 3600_000) })],
    syncRuns: [{
      webhooks: [
        { afterMs: 50, badSignature: true, payload: webhook({ id: "FORGED" }) },
        { afterMs: 60, payload: webhook({ chat: "status@broadcast", id: "STATUS" }) },
        { afterMs: 70, payload: webhook({ chat: "120363@newsletter", id: "NEWS" }) },
        {
          afterMs: 80,
          payload: webhook({
            Media: { Caption: "see this", FileLength: 1, Filename: "x.jpg", MimeType: "image/jpeg", Type: "image" },
            ReplyToID: "Q1",
            Text: "",
            chat: GROUP,
            id: "G1",
            sender: ALICE,
          }),
        },
        { afterMs: 90, payload: webhook({ chat: OWNER, fromMe: true, id: "SELF", text: "@s4 hi" }) },
      ],
    }],
  });
  const c = collector();
  const subscription = await h.module.subscribe(c.input);
  await waitFor(() => c.events.length >= 2 && c.events, { what: "events" });
  await waitFor(async () => (await h.webhookResults()).length >= 5);
  const results = await h.webhookResults();
  expect(results.find((result) => result.id === "FORGED")?.status).toBe(401);
  expect(results.filter((result) => result.id !== "FORGED").every((result) => result.status === 204)).toBe(true);

  expect(c.events.map((event) => event.message.providerMessageId)).toEqual(["G1", "SELF"]);
  const [group, self] = c.events;
  expect(group).toMatchObject({
    conversation: { chatJid: GROUP, provider: "whatsapp", version: 1 },
    conversationFacts: { isGroup: true, ownerParticipated: true, selfChat: false },
    message: {
      fromMe: false,
      kind: "message",
      media: { caption: "see this", filename: "x.jpg", mimeType: "image/jpeg", type: "image" },
      replyToProviderMessageId: "Q1",
      sender: ALICE,
      text: "see this",
    },
    origin: "live",
    provider: "whatsapp",
  });
  expect(self).toMatchObject({
    conversationFacts: { isGroup: false, ownerParticipated: true, selfChat: true },
    message: { fromMe: true, sender: OWNER, text: "@s4 hi" },
  });
  expect(c.health).toContainEqual({ state: "connected" });
  const sync = (await h.invocations("sync"))[0]!.args;
  expect(sync).toContain("--follow");
  expect(sync).toContain("--webhook-allow-private");
  expect(sync.find((arg) => arg.startsWith("--webhook="))).toMatch(/^--webhook=http:\/\/127\.0\.0\.1:\d+\/whatsapp$/);
  await subscription.close();
});

test("duplicate webhook posts are delivered once", async () => {
  const payload = webhook({ id: "DUP" });
  const h = await setup({
    auth: LINKED,
    syncRuns: [{
      webhooks: [
        { afterMs: 30, payload },
        { afterMs: 40, payload },
        { afterMs: 50, payload: webhook({ id: "NEXT" }) },
      ],
    }],
  });
  const c = collector();
  await h.module.subscribe(c.input);
  await waitFor(() => c.events.some((event) => event.message.providerMessageId === "NEXT"));
  await waitFor(async () => (await h.webhookResults()).length === 3);
  expect(c.events.map((event) => event.message.providerMessageId)).toEqual(["DUP", "NEXT"]);
});

test("stale live messages are suppressed and delivered by the post-backlog recovery sweep", async () => {
  const staleTs = iso(10 * 60_000);
  const scenario = {
    auth: LINKED,
    syncRuns: [{
      events: [{ afterMs: 600, data: { count: 1 }, event: "offline_sync_completed" }],
      webhooks: [{ afterMs: 30, payload: webhook({ id: "STALE", text: "@s4 while offline", ts: staleTs }) }],
    }],
  };
  const h = await setup(scenario);
  await seedState(h.statePath, iso(60 * 60_000));
  const c = collector();
  await h.module.subscribe(c.input);
  await waitFor(async () => (await h.webhookResults()).length === 1);
  await Bun.sleep(50);
  expect(c.events).toEqual([]);
  // The row lands in the local store with the backlog, before offline_sync_completed.
  await h.writeScenario({ ...scenario, messages: [row({ id: "STALE", text: "@s4 while offline", ts: staleTs })] });
  await waitFor(() => c.events.length === 1, { what: "recovered event" });
  expect(c.events[0]).toMatchObject({ message: { providerMessageId: "STALE", text: "@s4 while offline" }, origin: "recovered" });
  await waitFor(() => c.recovery.length === 2);
  expect(c.recovery).toEqual([{ messages: 0, status: "recovered" }, { messages: 1, status: "recovered" }]);
  const sweep = (await h.invocations("messages list")).find((entry) => entry.args.includes("--asc"))!.args;
  expect(sweep).toContain("--limit=500");
  expect(sweep.some((arg) => arg.startsWith("--after="))).toBe(true);
});

test("a message filed under another address after a restart is not delivered again", async () => {
  // wacli can move a chat between its phone-number JID and its LID, e.g. when it restarts.
  const aliceLid = "84444000000001@lid";
  const h = await setup({
    auth: LINKED,
    syncRuns: [{ webhooks: [{ afterMs: 30, payload: webhook({ chat: aliceLid, id: "MOVED", sender: aliceLid, ts: iso(2_000) }) }] }],
  });
  const first = collector();
  const subscription = await h.module.subscribe(first.input);
  await waitFor(() => first.events.length === 1);
  await waitFor(() => first.recovery.length === 1);
  await subscription.close();

  // Place the re-filed row inside the next sweep's window, as a restart's recovery sweep sees it.
  const state = JSON.parse(await readFile(h.statePath, "utf8")) as { watermark: string };
  await h.writeScenario({
    auth: LINKED,
    messages: [row({ chat: ALICE, id: "MOVED", ts: new Date(Date.parse(state.watermark) + 1_500).toISOString() })],
    syncRuns: [{}],
  });
  const second = collector();
  await h.newModule().subscribe(second.input);
  await waitFor(() => second.recovery.length === 1);
  expect(second.events).toEqual([]);
});

test("delivered keys saved with a chat address still suppress the message", async () => {
  const h = await setup({ auth: LINKED, syncRuns: [{}] });
  const watermark = new Date(Date.now() - 60_000).toISOString();
  await seedState(h.statePath, watermark, [`${ALICE}|OLDKEY`, `${ALICE}|OLDEDIT|edit|abc`, "sent|MINE"]);
  await h.writeScenario({
    auth: LINKED,
    messages: [row({ chat: "84444000000001@lid", id: "OLDKEY", ts: new Date(Date.parse(watermark) + 1_500).toISOString() })],
    syncRuns: [{}],
  });
  const c = collector();
  await h.newModule().subscribe(c.input);
  await waitFor(() => c.recovery.length === 1);
  expect(c.events).toEqual([]);
});

test("first subscribe does not replay history; watermark survives a new instance", async () => {
  const h = await setup({
    auth: LINKED,
    messages: [row({ id: "ANCIENT", ts: iso(60_000) })],
    syncRuns: [{ webhooks: [{ afterMs: 30, payload: webhook({ id: "LIVE1", ts: iso(2_000) }) }] }],
  });
  const first = collector();
  const subscription = await h.module.subscribe(first.input);
  await waitFor(() => first.events.length === 1);
  await waitFor(() => first.recovery.length === 1);
  expect(first.events[0]!.message.providerMessageId).toBe("LIVE1");
  await subscription.close();

  const state = JSON.parse(await readFile(h.statePath, "utf8")) as { delivered: string[]; watermark: string };
  expect(state.delivered).toContain("id|LIVE1");
  expect(Date.parse(state.watermark)).toBeGreaterThan(Date.now() - 10_000);
  expect((await stat(h.statePath)).mode & 0o777).toBe(0o600);

  const liveRowTs = first.events[0]!.message.occurredAt;
  await h.writeScenario({
    auth: LINKED,
    messages: [
      row({ id: "ANCIENT", ts: iso(60_000) }),
      row({ id: "LIVE1", ts: liveRowTs }),
      row({ id: "MISSED", ts: new Date(Date.parse(state.watermark) + 1_500).toISOString() }),
    ],
    syncRuns: [{}],
  });
  const second = collector();
  await h.newModule().subscribe(second.input);
  await waitFor(() => second.recovery.length === 1);
  expect(second.events.map((event) => [event.message.providerMessageId, event.origin])).toEqual([["MISSED", "recovered"]]);
});

test("recovery sweeps report limits and failures", async () => {
  const h = await setup(
    {
      auth: LINKED,
      messages: [1, 2, 3].map((n) => row({ id: `R${n}`, ts: iso(30_000 - n * 1_000) })),
      syncRuns: [{}],
    },
    { recoveryLimits: { maxMessages: 2 } },
  );
  await seedState(h.statePath, iso(60 * 60_000));
  const c = collector();
  await h.module.subscribe(c.input);
  await waitFor(() => c.recovery.length === 1);
  expect(c.recovery[0]).toEqual({ messages: 2, reason: "sweep-limit", status: "degraded" });
  expect(c.events.map((event) => event.message.providerMessageId)).toEqual(["R1", "R2"]);

  const failing = await setup({ auth: LINKED, listFails: true, syncRuns: [{}] });
  const f = collector();
  await failing.module.subscribe(f.input);
  await waitFor(() => f.recovery.length === 1);
  expect(f.recovery[0]).toEqual({ messages: 0, reason: "sweep-failed", status: "degraded" });
});

test("reply waits for the delegate socket and passes the self and quote flags", async () => {
  const h = await setup({ auth: LINKED, send: { id: "3EB0SENT", mode: "ok" }, syncRuns: [{ socketDelayMs: 400 }] });
  await h.module.subscribe(collector().input);
  const started = Date.now();
  const outcome = await h.module.reply({
    conversation: h.reference(OWNER),
    quote: { providerMessageId: "ORIG", sender: OWNER },
    text: "--looks like a flag",
  });
  expect(outcome).toEqual({ providerMessageId: "3EB0SENT", status: "confirmed" });
  expect(Date.now() - started).toBeGreaterThanOrEqual(300);
  const args = (await h.invocations("send"))[0]!.args;
  expect(args).toContain(`--to=${OWNER}`);
  expect(args).toContain("--message=--looks like a flag");
  expect(args).toContain("--allow-self");
  expect(args).toContain("--reply-to=ORIG");
  expect(args).toContain(`--reply-to-sender=${OWNER}`);

  await h.module.reply({ conversation: h.reference(ALICE), text: "hi" });
  const second = (await h.invocations("send"))[1]!.args;
  expect(second.some((arg) => arg.startsWith("--reply-to"))).toBe(false);
});

test("text replies reach a self-chat addressed by LID before its LID is learned", async () => {
  // After a restart Pronto hasn't seen a live self-chat message, so it can't recognise the LID chat.
  const selfLid = "211128126849043@lid";
  const h = await setup({ auth: LINKED, send: { id: "3EB0SELF", mode: "ok" }, syncRuns: [{}] });
  await h.module.subscribe(collector().input);
  const outcome = await h.module.reply({
    conversation: h.reference(selfLid),
    quote: { providerMessageId: "PHOTO", sender: OWNER },
    text: "It's a red circle.",
  });
  expect(outcome).toEqual({ providerMessageId: "3EB0SELF", status: "confirmed" });
  const args = (await h.invocations("send"))[0]!.args;
  expect(args).toContain(`--to=${selfLid}`);
  expect(args).toContain("--allow-self");
});

test("reply fails retryably when the delegate never becomes ready", async () => {
  const h = await setup({ auth: LINKED, syncRuns: [{ socketDelayMs: -1 }] }, {}, { readinessTimeoutMs: 200 });
  await h.module.subscribe(collector().input);
  const outcome = await h.module.reply({ conversation: h.reference(ALICE), text: "hi" });
  expect(outcome).toMatchObject({ retryable: true, status: "failed" });
  expect(await h.invocations("send")).toEqual([]);
});

test("send outcomes map to confirmed, failed, and ambiguous without retries", async () => {
  const h = await setup({ auth: LINKED }, {}, { sendTimeoutMs: 400 });
  const send = async (mode: "crash" | "error" | "garbage" | "hang" | "ok", error?: string) => {
    await h.writeScenario({ auth: LINKED, send: { mode, ...(error === undefined ? {} : { error }) } });
    return await h.module.reply({ conversation: h.reference(ALICE), text: "hello" });
  };
  expect(await send("ok")).toEqual({ providerMessageId: "3EB0FAKE", status: "confirmed" });
  expect(await send("error", "store is locked (another wacli is running?)")).toMatchObject({ retryable: true, status: "failed" });
  expect(await send("error", "not connected to WhatsApp")).toMatchObject({ retryable: true, status: "failed" });
  expect(await send("error", "invalid recipient")).toEqual({ reason: "invalid recipient", retryable: false, status: "failed" });
  expect(await send("error", "context deadline exceeded")).toEqual({ status: "ambiguous" });
  expect(await send("garbage")).toEqual({ status: "ambiguous" });
  expect(await send("crash")).toEqual({ status: "ambiguous" });
  expect(await send("hang")).toEqual({ status: "ambiguous" });
  expect((await h.invocations("send")).length).toBe(8);
  expect(await h.module.reply({ conversation: h.reference(ALICE), text: "   " }))
    .toMatchObject({ retryable: false, status: "failed" });
});

test("tampered, foreign, and expired references are rejected", async () => {
  const h = await setup({ auth: LINKED, messages: [] }, { presence: true });
  const valid = h.reference(ALICE);
  const cases = [
    { ...valid, token: `${valid.token.slice(0, -2)}xx` },
    { ...valid, chatJid: BOB },
    { ...valid, provider: "apple-messages" },
    { ...valid, version: 2 },
    { ...valid, expiresAt: new Date(Date.now() + 3_600_000).toISOString() },
    h.reference(ALICE, -1),
  ] as unknown as typeof valid[];
  for (const conversation of cases) {
    await expect(h.module.reply({ conversation, text: "x" })).rejects.toThrow(/conversation scope is unavailable/);
    await expect(h.module.history({ conversation, limit: 5 })).rejects.toThrow(/conversation scope is unavailable/);
    await expect(h.module.presence!.setTyping(conversation, true)).rejects.toThrow(/conversation scope is unavailable/);
  }
  const otherKey = createProntoWhatsapp({
    referenceKey: "a-completely-different-key-of-32-plus-chars",
    statePath: h.statePath,
    storeDir: h.store,
    wacliPath: FAKE_WACLI,
  });
  await expect(otherKey.reply({ conversation: valid, text: "x" })).rejects.toThrow(/scope is unavailable/);
  expect(await h.invocations("send")).toEqual([]);
});

test("references issued by the module expire after scopeLimits.ttlMs", async () => {
  const h = await setup({ auth: LINKED, syncRuns: [{ webhooks: [{ afterMs: 20, payload: webhook({ id: "T" }) }] }] }, {
    scopeLimits: { ttlMs: 150 },
  });
  const c = collector();
  await h.module.subscribe(c.input);
  const event = await waitFor(() => c.events[0]);
  expect(Date.parse(event.conversation.expiresAt) - Date.now()).toBeLessThanOrEqual(150);
  await Bun.sleep(200);
  await expect(h.module.history({ conversation: event.conversation, limit: 5 })).rejects.toThrow(/scope/);
});

test("ownerParticipated is looked up once per chat and cached when positive", async () => {
  const h = await setup({
    auth: LINKED,
    messages: [row({ chat: ALICE, fromMe: true, id: "MINE", ts: iso(3 * 24 * 3600_000) })],
    syncRuns: [{
      webhooks: [
        { afterMs: 20, payload: webhook({ chat: ALICE, id: "A1" }) },
        { afterMs: 30, payload: webhook({ chat: ALICE, id: "A2" }) },
        { afterMs: 40, payload: webhook({ chat: BOB, id: "B1" }) },
      ],
    }],
  });
  const c = collector();
  await h.module.subscribe(c.input);
  await waitFor(() => c.events.length === 3);
  expect(c.events.map((event) => event.conversationFacts.ownerParticipated)).toEqual([true, true, false]);
  const lookups = (await h.invocations("messages list")).filter((entry) => entry.args.includes("--from-me"));
  expect(lookups.map((entry) => entry.args.find((arg) => arg.startsWith("--chat=")))).toEqual([
    `--chat=${ALICE}`,
    `--chat=${BOB}`,
  ]);
});

test("history returns oldest first with a clamped limit", async () => {
  const h = await setup({
    auth: LINKED,
    messages: [
      row({ id: "H1", ts: iso(30_000) }),
      row({ fromMe: true, id: "H2", ts: iso(20_000) }),
      row({ id: "H3", ts: iso(10_000) }),
      row({ chat: BOB, id: "OTHER", ts: iso(5_000) }),
    ],
  });
  const events = await h.module.history({ conversation: h.reference(ALICE), limit: 500 });
  expect(events.map((event) => event.message.providerMessageId)).toEqual(["H1", "H2", "H3"]);
  expect(events.every((event) => event.origin === "recovered" && event.conversationFacts.ownerParticipated)).toBe(true);
  expect(events[1]!.message.sender).toBe(OWNER);
  const args = (await h.invocations("messages list"))[0]!.args;
  expect(args).toContain("--limit=100");
  expect(args).toContain(`--chat=${ALICE}`);
});

test("participants name a direct chat's two people and a group's stored members", async () => {
  const newest = iso(10_000);
  const h = await setup({
    auth: LINKED,
    groups: {
      [GROUP]: [
        { updated_at: iso(20_000), user_jid: ALICE },
        { updated_at: newest, user_jid: "15550001111:3@s.whatsapp.net" },
        { updated_at: newest, user_jid: "987654321@lid" },
      ],
      "120363000000000002@g.us": [{ updated_at: iso(5_000), user_jid: BOB }],
    },
  });
  expect(await h.module.participants({ conversation: h.reference(ALICE) })).toMatchObject({
    complete: true,
    participants: [ALICE, OWNER],
  });
  expect((await h.module.participants({ conversation: h.reference(OWNER) })).participants).toEqual([OWNER]);
  expect(await h.module.participants({ conversation: h.reference(GROUP) })).toEqual({
    complete: true,
    observedAt: newest,
    participants: [ALICE, OWNER, "987654321@lid"],
  });
  // A list without this account cannot be the group this account is in.
  expect((await h.module.participants({ conversation: h.reference("120363000000000002@g.us") })).complete)
    .toBe(false);
  expect(await h.module.participants({ conversation: h.reference("120363000000000003@g.us") })).toMatchObject({
    complete: false,
    participants: [],
  });
  await expect(h.module.participants({ conversation: h.reference("120363000000broken@g.us") }))
    .rejects.toThrow(/group members are unavailable/);
  const lookups = await h.invocations("groups participants list");
  expect(lookups.every((entry) => entry.args.includes("--read-only"))).toBe(true);
  await expect(h.module.participants({ conversation: { ...h.reference(GROUP), token: "forged" } }))
    .rejects.toThrow(/scope/);
});

test("attachments download privately through the lock-free media path", async () => {
  const h = await setup({
    auth: LINKED,
    media: { PHOTO: { content: "fake jpeg bytes", name: "photo.jpg" } },
    messages: [
      row({ id: "PHOTO", MediaCaption: "@s4 what is this?", MediaType: "image", MimeType: "image/jpeg", text: "", ts: iso(5_000) }),
      row({ id: "PLAIN", ts: iso(4_000) }),
    ],
  });
  const attachment = await h.module.materializeAttachment({
    conversation: h.reference(ALICE),
    maxBytes: 1_024,
    providerMessageId: "PHOTO",
  });
  expect(attachment).toMatchObject({ mimeType: "image/jpeg", name: "photo.jpg", sizeBytes: 15 });
  expect(await readFile(attachment.path, "utf8")).toBe("fake jpeg bytes");
  expect(attachment.sha256).toMatch(/^[0-9a-f]{64}$/);
  expect((await stat(attachment.path)).mode & 0o777).toBe(0o600);
  expect((await stat(dirname(attachment.path))).mode & 0o777).toBe(0o700);
  const args = (await h.invocations("media download"))[0]!.args;
  expect(args).toContain("--read-only");
  expect(args).toContain(`--chat=${ALICE}`);
  expect(args).toContain("--id=PHOTO");
  await attachment.dispose();
  await expect(stat(attachment.path)).rejects.toThrow();

  await expect(h.module.materializeAttachment({
    conversation: h.reference(ALICE), maxBytes: 4, providerMessageId: "PHOTO",
  })).rejects.toThrow("exceeds the size budget");
  await expect(h.module.materializeAttachment({
    conversation: h.reference(ALICE), maxBytes: 1_024, providerMessageId: "PLAIN",
  })).rejects.toThrow("no downloadable attachment");
  await expect(h.module.materializeAttachment({
    conversation: h.reference(BOB), maxBytes: 1_024, providerMessageId: "PHOTO",
  })).rejects.toThrow("no downloadable attachment");
  await expect(h.module.materializeAttachment({
    conversation: { ...h.reference(ALICE), token: "forged" }, maxBytes: 1_024, providerMessageId: "PHOTO",
  })).rejects.toThrow("scope is unavailable");
});

test("a crashed sync child is restarted and reconnects", async () => {
  const h = await setup({ auth: LINKED, syncRuns: [{ exitAfterMs: 150, exitCode: 1 }, {}] });
  const c = collector();
  await h.module.subscribe(c.input);
  await waitFor(async () => (await h.invocations("sync")).length === 2, { what: "restart" });
  await waitFor(() => c.health.filter((value) => value.state === "connected").length === 2);
  expect(c.health.map((value) => value.state)).toEqual(["starting", "connected", "reconnecting", "connected"]);
});

test("logged_out reports needs_link, terminates, and does not restart", async () => {
  const h = await setup({
    auth: LINKED,
    syncRuns: [{ events: [{ afterMs: 100, data: { reason: "logged out" }, event: "logged_out" }] }],
  });
  const c = collector();
  const subscription = await h.module.subscribe(c.input);
  await subscription.terminated;
  await Bun.sleep(150);
  expect(c.health.at(-1)).toEqual({ state: "needs_link" });
  expect((await h.invocations("sync")).length).toBe(1);
  expect(await h.module.reply({ conversation: h.reference(ALICE), text: "x" }))
    .toMatchObject({ retryable: false, status: "failed" });
});

test("close awaits the in-flight consumer callback and stops the child", async () => {
  const h = await setup({ auth: LINKED, syncRuns: [{ webhooks: [{ afterMs: 20, payload: webhook({ id: "SLOW" }) }] }] });
  let finished = false;
  let started = false;
  const subscription = await h.module.subscribe({
    onEvent: async () => {
      started = true;
      await Bun.sleep(200);
      finished = true;
    },
  });
  await waitFor(() => started);
  await subscription.close();
  expect(finished).toBe(true);
  await expect(stat(`${h.store}/.send.sock`)).rejects.toThrow();
});

test("presence sends typing and paused through the running sync", async () => {
  const h = await setup({ auth: LINKED, syncRuns: [{}] }, { presence: true });
  await h.module.subscribe(collector().input);
  await waitFor(async () => (await stat(`${h.store}/.send.sock`).catch(() => null)) !== null);
  await Bun.sleep(50);
  await h.module.presence!.setTyping(h.reference(ALICE), true);
  await h.module.presence!.setTyping(h.reference(ALICE), false);
  const presence = await h.invocations("presence");
  expect(presence.map((entry) => entry.command)).toEqual(["presence typing", "presence paused"]);
  expect(presence[0]!.args).toContain(`--to=${ALICE}`);
});

test("reply with a file sends it captioned and quoted through the running sync", async () => {
  const h = await setup({ auth: LINKED, send: { id: "3EB0FILE", mode: "ok" }, syncRuns: [{}] });
  await h.module.subscribe(collector().input);
  const photo = join(h.dir, "chart.png");
  const voice = join(h.dir, "memo.m4a");
  await writeFile(photo, "png bytes");
  await writeFile(voice, "m4a bytes");
  const outcome = await h.module.reply({
    conversation: h.reference(OWNER),
    filePath: photo,
    quote: { providerMessageId: "ORIG", sender: OWNER },
    text: "Here is the chart",
  });
  expect(outcome).toEqual({ providerMessageId: "3EB0FILE", status: "confirmed" });
  await h.module.reply({ conversation: h.reference(ALICE), filePath: voice, text: "Listen" });
  const [first, second] = await h.invocations("send");
  expect(first!.command).toBe("send file");
  expect(first!.args).toEqual(expect.arrayContaining([
    `--to=${OWNER}`, `--file=${photo}`, "--caption=Here is the chart", "--as=auto",
    "--reply-to=ORIG", `--reply-to-sender=${OWNER}`,
  ]));
  expect(first!.args).not.toContain("--allow-self");
  expect(first!.args.some((arg) => arg.startsWith("--message"))).toBe(false);
  expect(second!.args).toContain("--as=document");
});

test("reply refuses unsendable files without invoking wacli and never retries a file send", async () => {
  const h = await setup({ auth: LINKED }, {}, { attachmentTimeoutMs: 400 });
  const file = join(h.dir, "report.pdf");
  await writeFile(file, "pdf bytes");
  const reply = async (filePath: string) => {
    return await h.module.reply({ conversation: h.reference(ALICE), filePath, text: "report" });
  };
  expect(await reply("report.pdf")).toMatchObject({ retryable: false, status: "failed" });
  expect(await reply(join(h.dir, "missing.pdf"))).toMatchObject({ retryable: false, status: "failed" });
  expect(await reply(h.dir)).toMatchObject({ retryable: false, status: "failed" });
  expect(await h.invocations("send")).toEqual([]);

  await h.writeScenario({ auth: LINKED, send: { mode: "hang" } });
  expect(await reply(file)).toEqual({ status: "ambiguous" });
  await h.writeScenario({ auth: LINKED, send: { error: "invalid recipient", mode: "error" } });
  expect(await reply(file)).toEqual({ reason: "invalid recipient", retryable: false, status: "failed" });
  expect((await h.invocations("send file")).length).toBe(2);
});

test("react goes through the running sync with the message sender", async () => {
  const h = await setup({ auth: LINKED, send: { id: "3EB0REACT", mode: "ok" }, syncRuns: [{}] });
  const react = async (chat: string, sender: string | null, id = "ORIG") => {
    return await h.module.react({ conversation: h.reference(chat), emoji: "👀", providerMessageId: id, sender });
  };
  expect(await react(ALICE, ALICE)).toMatchObject({ retryable: true, status: "failed" });
  await h.module.subscribe(collector().input);
  await waitFor(async () => (await stat(`${h.store}/.send.sock`).catch(() => null)) !== null);
  await Bun.sleep(50);
  expect(await react(GROUP, BOB)).toEqual({ providerMessageId: "3EB0REACT", status: "confirmed" });
  expect(await react(ALICE, ALICE)).toMatchObject({ status: "confirmed" });
  expect(await react(GROUP, null)).toMatchObject({ retryable: false, status: "failed" });
  expect(await react(ALICE, ALICE, "not an id!")).toMatchObject({ retryable: false, status: "failed" });
  const reactions = await h.invocations("send react");
  expect(reactions).toHaveLength(2);
  expect(reactions[0]!.args).toEqual(expect.arrayContaining([
    `--to=${GROUP}`, "--id=ORIG", "--reaction=👀", `--sender=${BOB}`,
  ]));
  expect(reactions[1]!.args).toContain(`--sender=${ALICE}`);
});

test("expired media fails with a typed attachment-expired error", async () => {
  const h = await setup({
    auth: LINKED,
    media: { OLD: { content: "", expired: true, name: "old.jpg" } },
    messages: [row({ id: "OLD", MediaType: "image", MimeType: "image/jpeg", text: "", ts: iso(5_000) })],
  });
  const failure = await h.module.materializeAttachment({
    conversation: h.reference(ALICE), maxBytes: 1_024, providerMessageId: "OLD",
  }).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(WhatsappAttachmentExpiredError);
  expect((failure as WhatsappAttachmentExpiredError).code).toBe("attachment-expired");
  expect(await h.invocations("media retry")).toEqual([]);
});

test("link yields QR codes then the linked account", async () => {
  const h = await setup({
    auth: { authenticated: false },
    link: {
      events: [
        { afterMs: 10, data: { code: "warning-code", message: "noise" }, event: "warning" },
        { afterMs: 20, data: { code: "2@QRPAYLOAD" }, event: "qr_code" },
        { afterMs: 40, authenticate: true, event: "connected" },
        { afterMs: 60, event: "idle_exit" },
      ],
      exitCode: 0,
    },
  });
  const steps: WhatsappLinkStep[] = [];
  for await (const step of h.module.link()) steps.push(step);
  expect(steps).toEqual([{ code: "2@QRPAYLOAD", type: "qr" }, { linkedJid: OWNER, type: "linked" }]);

  await h.writeScenario({
    auth: { authenticated: false },
    link: { events: [{ afterMs: 10, data: { message: "pairing rejected" }, event: "error" }], exitCode: 1 },
  });
  const failed: WhatsappLinkStep[] = [];
  for await (const step of h.module.link({ phone: "+1 555 000 1111" })) failed.push(step);
  expect(failed).toEqual([{ reason: "pairing rejected", type: "failed" }]);
  expect((await h.invocations("auth"))
    .some((entry) => entry.command === "auth" && entry.args.includes("--phone=15550001111"))).toBe(true);
});

test("the device label names this Mac in WhatsApp's linked devices", async () => {
  const h = await setup({
    auth: { authenticated: false },
    link: { events: [{ afterMs: 10, authenticate: true, event: "connected" }], exitCode: 0 },
  }, { deviceLabel: "Pronto" });
  for await (const _ of h.module.link()) void _;
  await h.module.qualify();
  const invocations = await h.invocations() as Array<{ command: string; deviceLabel?: string | null }>;
  expect(invocations.length).toBeGreaterThan(1);
  expect(invocations.every((entry) => entry.deviceLabel === "Pronto")).toBe(true);
});

test("link retries when wacli auth exits before showing a code", async () => {
  const early = { events: [], exitCode: 0 };
  const h = await setup({
    auth: { authenticated: false },
    link: [early, { events: [{ afterMs: 10, data: { code: "2@RETRIED" }, event: "qr_code" }, { afterMs: 20, authenticate: true, event: "connected" }], exitCode: 0 }],
  });
  const steps: WhatsappLinkStep[] = [];
  for await (const step of h.module.link()) steps.push(step);
  expect(steps).toEqual([{ code: "2@RETRIED", type: "qr" }, { linkedJid: OWNER, type: "linked" }]);
  expect((await h.invocations("auth")).filter((entry) => entry.command === "auth")).toHaveLength(2);

  await h.writeScenario({ auth: { authenticated: false }, link: early });
  const failed: WhatsappLinkStep[] = [];
  for await (const step of h.module.link()) failed.push(step);
  expect(failed).toEqual([{ reason: "WhatsApp didn't offer a link code. Wait a minute and try again.", type: "failed" }]);
});

test("link can be aborted", async () => {
  const h = await setup({
    auth: { authenticated: false },
    link: { events: [{ afterMs: 10, data: { code: "QR" }, event: "qr_code" }, { afterMs: 5_000, event: "noop" }], exitCode: 0 },
  });
  const controller = new AbortController();
  const steps: WhatsappLinkStep[] = [];
  const started = Date.now();
  for await (const step of h.module.link({ signal: controller.signal })) {
    steps.push(step);
    controller.abort();
  }
  expect(steps).toEqual([{ code: "QR", type: "qr" }]);
  expect(Date.now() - started).toBeLessThan(2_000);
});

test("unlink logs out and ends the subscription", async () => {
  const h = await setup({ auth: LINKED, syncRuns: [{}] });
  const c = collector();
  const subscription = await h.module.subscribe(c.input);
  await waitFor(() => c.health.some((value) => value.state === "connected"));
  await h.module.unlink();
  await subscription.terminated;
  expect(await h.module.qualify()).toMatchObject({ status: "needs_link" });
});

test("unlink succeeds when logout clears this Mac but WhatsApp never confirms", async () => {
  const h = await setup({ auth: LINKED, logout: "clear-then-hang" }, {}, { logoutTimeoutMs: 300 });
  await h.module.unlink();
  expect(await h.module.qualify()).toMatchObject({ status: "needs_link" });

  const stuck = await setup({ auth: LINKED, logout: "hang" }, {}, { logoutTimeoutMs: 300 });
  await expect(stuck.module.unlink()).rejects.toThrow("wacli auth logout failed");
});
