#!/usr/bin/env bun
// Emulates the wacli 0.19 commands pronto-whatsapp uses, driven by <store>/scenario.json.
import { createHmac } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";

const MAX_FIXTURE_DELAY_MS = 10_000;

export interface FakeTimedEvent {
  readonly afterMs: number;
  /** Marks the scenario as authenticated before emitting (link flow). */
  readonly authenticate?: boolean;
  readonly data?: Record<string, unknown>;
  readonly event: string;
}

export interface FakeWebhook {
  readonly afterMs: number;
  readonly badSignature?: boolean;
  readonly payload: Record<string, unknown>;
}

export interface FakeSyncRun {
  readonly connectDelayMs?: number;
  readonly events?: readonly FakeTimedEvent[];
  readonly exitAfterMs?: number;
  readonly exitCode?: number;
  /** Negative means never create the delegate socket. */
  readonly socketDelayMs?: number;
  readonly webhooks?: readonly FakeWebhook[];
}

export interface FakeScenario {
  readonly auth?: { readonly authenticated: boolean; readonly linkedJid?: string };
  readonly link?: { readonly events: readonly FakeTimedEvent[]; readonly exitCode: number };
  readonly listFails?: boolean;
  /** Downloadable media by message id: the file name wacli writes and its contents. */
  readonly media?: Readonly<Record<string, { readonly content: string; readonly name: string }>>;
  readonly messages?: readonly Record<string, unknown>[];
  readonly send?: {
    readonly error?: string;
    readonly id?: string;
    readonly mode: "crash" | "error" | "garbage" | "hang" | "ok";
  };
  readonly syncRuns?: readonly FakeSyncRun[];
}

const BOOLEAN_FLAGS = new Set([
  "allow-self", "asc", "events", "follow", "from-me", "json", "read-only", "webhook-allow-private",
]);

const argv = process.argv.slice(2);
const flags = new Map<string, string | true>();
const words: string[] = [];
for (let index = 0; index < argv.length; index += 1) {
  const arg = argv[index] ?? "";
  if (arg.startsWith("--")) {
    const body = arg.slice(2);
    const equals = body.indexOf("=");
    if (equals >= 0) flags.set(body.slice(0, equals), body.slice(equals + 1));
    else if (BOOLEAN_FLAGS.has(body)) flags.set(body, true);
    else {
      flags.set(body, argv[index + 1] ?? "");
      index += 1;
    }
  } else {
    words.push(arg);
  }
}

const store = typeof flags.get("store") === "string" ? flags.get("store") as string : "";
const scenarioPath = join(store, "scenario.json");
const invocationsPath = join(store, "invocations.ndjson");
const socketPath = join(store, ".send.sock");
const command = words.join(" ");

function scenario(): FakeScenario {
  return existsSync(scenarioPath) ? JSON.parse(readFileSync(scenarioPath, "utf8")) as FakeScenario : {};
}

function priorInvocations(prefix: string): number {
  if (!existsSync(invocationsPath)) return 0;
  return readFileSync(invocationsPath, "utf8").split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as { command: string })
    .filter((entry) => entry.command.startsWith(prefix)).length;
}

function record(): void {
  if (store === "") return;
  appendFileSync(invocationsPath, `${JSON.stringify({ args: argv, at: Date.now(), command })}\n`);
}

function ok(data: unknown): never {
  process.stdout.write(`${JSON.stringify({ data, error: null, success: true })}\n`);
  process.exit(0);
}

function fail(message: string): never {
  if (flags.get("json") === true) {
    process.stderr.write(`${JSON.stringify({ data: null, error: message, success: false })}\n`);
  } else {
    process.stderr.write(`${message}\n`);
  }
  process.exit(1);
}

function emit(event: string, data?: Record<string, unknown>): void {
  process.stderr.write(`${JSON.stringify({ event, ...(data === undefined ? {} : { data }), ts: Date.now() })}\n`);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function runSync(): Promise<void> {
  const runIndex = priorInvocations("sync");
  record();
  const current = scenario();
  if (current.auth?.authenticated !== true) {
    emit("error", { message: "not authenticated; run `wacli auth`" });
    process.exit(1);
  }
  const runs = current.syncRuns ?? [{}];
  const run = runs[Math.min(runIndex, runs.length - 1)] ?? {};
  // Fixture inputs are test-controlled, but stay bounded: loopback webhooks and short delays only.
  const url = loopbackUrl(String(flags.get("webhook") ?? ""));
  const secret = String(flags.get("webhook-secret") ?? "");
  rmSync(socketPath, { force: true });
  const server = createServer((socket) => socket.end());
  const cleanup = () => {
    server.close();
    rmSync(socketPath, { force: true });
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      cleanup();
      process.exit(0);
    });
  }
  setInterval(() => undefined, 1_000);
  setTimeout(() => emit("connected"), boundedDelay(run.connectDelayMs));
  if ((run.socketDelayMs ?? 0) >= 0) {
    setTimeout(() => server.listen(socketPath), boundedDelay(run.socketDelayMs));
  }
  if (run.exitAfterMs !== undefined) {
    setTimeout(() => process.exit(run.exitCode ?? 1), boundedDelay(run.exitAfterMs));
  }
  for (const timed of run.events ?? []) {
    setTimeout(() => {
      emit(timed.event, timed.data);
      if (timed.event === "logged_out") {
        emit("stopping", { reason: "logged_out" });
        setTimeout(() => {
          cleanup();
          process.exit(0);
        }, 20);
      }
    }, boundedDelay(timed.afterMs));
  }
  const started = Date.now();
  for (const webhook of [...(run.webhooks ?? [])].sort((a, b) => a.afterMs - b.afterMs)) {
    await sleep(boundedDelay(started + webhook.afterMs - Date.now()));
    const body = JSON.stringify(webhook.payload);
    const signature = createHmac("sha256", webhook.badSignature ? "wrong-secret" : secret).update(body).digest("hex");
    let status = 0;
    try {
      const response = await fetch(url, {
        body,
        headers: { "Content-Type": "application/json", "X-Wacli-Signature": `sha256=${signature}` },
        method: "POST",
      });
      status = response.status;
    } catch {
      status = -1;
    }
    appendFileSync(join(store, "webhook-results.ndjson"), `${JSON.stringify({ id: webhook.payload.ID, status })}\n`);
  }
}

function listMessages(): never {
  const current = scenario();
  if (current.listFails) fail("database is locked");
  const chat = flags.get("chat");
  const after = typeof flags.get("after") === "string" ? Date.parse(flags.get("after") as string) : null;
  const limit = Number(flags.get("limit") ?? 50);
  let rows = [...(current.messages ?? [])];
  if (typeof chat === "string") rows = rows.filter((row) => row.ChatJID === chat);
  if (flags.get("from-me") === true) rows = rows.filter((row) => row.FromMe === true);
  if (after !== null) {
    rows = rows.filter((row) => Math.floor(Date.parse(String(row.Timestamp)) / 1000) > Math.floor(after / 1000));
  }
  rows.sort((a, b) => Date.parse(String(a.Timestamp)) - Date.parse(String(b.Timestamp)));
  if (flags.get("asc") !== true) rows.reverse();
  ok({ fts: true, messages: rows.slice(0, limit) });
}

async function send(): Promise<void> {
  const current = scenario();
  const mode = current.send?.mode ?? "ok";
  if (mode === "ok" && current.syncRuns !== undefined && !existsSync(socketPath)) {
    fail("store is locked (another wacli is running?) (pid 1)");
  }
  switch (mode) {
    case "ok":
      ok({ id: current.send?.id ?? "3EB0FAKE", sent: true, to: flags.get("to") });
    case "error":
      fail(current.send?.error ?? "invalid recipient");
    case "garbage":
      process.stdout.write("not json\n");
      process.exit(0);
    case "crash":
      process.exit(2);
    case "hang":
      setInterval(() => undefined, 1_000);
      await sleep(60_000);
  }
}

async function runLink(): Promise<void> {
  const link = scenario().link ?? { events: [], exitCode: 1 };
  process.on("SIGINT", () => process.exit(130));
  const started = Date.now();
  for (const timed of link.events) {
    await sleep(Math.max(0, started + timed.afterMs - Date.now()));
    if (timed.authenticate) {
      const next = { ...scenario(), auth: { authenticated: true, linkedJid: "15550001111@s.whatsapp.net" } };
      writeFileSync(scenarioPath, JSON.stringify(next));
    }
    emit(timed.event, timed.data);
  }
  process.exit(link.exitCode);
}

if (command === "version") {
  record();
  process.stdout.write("0.19.0\n");
  process.exit(0);
} else if (command === "sync") {
  await runSync();
} else {
  record();
  switch (command) {
    case "auth status": {
      const auth = scenario().auth ?? { authenticated: false };
      ok(auth.authenticated && auth.linkedJid
        ? { authenticated: true, linked_jid: auth.linkedJid, phone: auth.linkedJid.split("@")[0] }
        : { authenticated: false });
    }
    case "auth logout":
      writeFileSync(scenarioPath, JSON.stringify({ ...scenario(), auth: { authenticated: false } }));
      process.exit(0);
    case "auth":
      await runLink();
      break;
    case "messages list":
      listMessages();
    case "messages show": {
      const row = (scenario().messages ?? []).find((message) => {
        return message.ChatJID === flags.get("chat") && message.MsgID === flags.get("id");
      });
      if (row === undefined) fail("message not found");
      ok(row);
    }
    case "media download": {
      if (flags.get("read-only") !== true) fail("store is locked (another wacli is running?)");
      const media = scenario().media?.[String(flags.get("id"))];
      if (media === undefined) fail("message has no downloadable media");
      writeFileSync(join(String(flags.get("output")), media.name), media.content);
      ok({ path: join(String(flags.get("output")), media.name) });
    }
    case "send text":
      await send();
      break;
    case "presence typing":
    case "presence paused":
      ok({ sent: true });
    default:
      fail(`unknown command: ${command}`);
  }
}

function boundedDelay(value: number | undefined): number {
  const delay = Number(value ?? 0);
  return Number.isFinite(delay) ? Math.min(Math.max(delay, 0), MAX_FIXTURE_DELAY_MS) : 0;
}

function loopbackUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") {
    throw new Error("fake wacli only posts webhooks to http://127.0.0.1");
  }
  return url.toString();
}
