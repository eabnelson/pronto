import { afterEach, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createProntoMessages, type MessagesRecoveryOutcome } from "../src/index";
import { databaseGeneration } from "../src/internal/generation";
import { ProviderStateStore } from "../src/internal/state";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

async function fixtureDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pronto-recovery-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function executableWithSource(directory: string, source: string): Promise<string> {
  const executable = join(directory, "imsg-fixture");
  await writeFile(executable, `#!/usr/bin/env bun\n${source}`, { mode: 0o700 });
  await chmod(executable, 0o700);
  return executable;
}

function rpcLoop(body: string): string {
  return `
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
    ${body}
  }
}
`;
}

function checkpointWitness(rowId = 40, providerMessageId = "checkpoint-guid") {
  return {
    providerMessageDigest: createHash("sha256").update(providerMessageId).digest("base64url"),
    rowId,
  };
}

test("keeps both fresh live messages when the first consumer takes six minutes", async () => {
  const directory = await fixtureDirectory();
  const databasePath = join(directory, "chat.db");
  await writeFile(databasePath, "database evidence");
  const executable = await executableWithSource(directory, rpcLoop(`
    let result = { ok: true };
    if (request.method === "initialize") result = {
      protocol_version: 1, version: "0.15.0",
      database: { path: ${JSON.stringify(databasePath)}, ready: true, features: { routing_metadata: true } },
      methods: ["initialize", "status", "chats.list", "messages.history", "messages.after", "messages.stats", "watch.subscribe", "watch.unsubscribe", "send"],
    };
    if (request.method === "messages.stats") result = {
      chats: [{ chat_id: request.params.chat_id, service: "iMessage" }], sent_messages: 1,
    };
    if (request.method === "watch.subscribe") result = { subscription: 1 };
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");
    if (request.method === "watch.subscribe") {
      const created_at = new Date().toISOString();
      process.stdout.write([1, 2].map((id) => JSON.stringify({
        jsonrpc: "2.0", method: "message", params: { subscription: 1,
          message: { chat_id: 40 + id, created_at, guid: "live-" + id, id,
            is_from_me: true, service: "iMessage", text: "hello" },
        },
      }) + "\\n").join(""));
    }
  `));
  const messages = createProntoMessages({ imsgPath: executable });
  const delivered: number[] = [];
  const realNow = Date.now;
  let offset = 0;
  const clock = spyOn(Date, "now").mockImplementation(() => realNow() + offset);
  let subscription: Awaited<ReturnType<typeof messages.subscribe>> | undefined;
  try {
    subscription = await messages.subscribe({
    onEvent: (event) => {
      delivered.push(event.message.rowId);
      if (event.message.rowId === 1) offset = 6 * 60_000;
    },
  });
    const deadline = realNow() + 1_000;
    while (delivered.length < 2 && realNow() < deadline) await Bun.sleep(10);
    expect(delivered).toEqual([1, 2]);
  } finally {
    clock.mockRestore();
    await subscription?.close();
    await messages.close();
  }
});

test.each([300, 10_000])("bounds notification memory and recovers a %i-message burst", async (count) => {
  const directory = await fixtureDirectory();
  const databasePath = join(directory, "chat.db");
  await writeFile(databasePath, "database evidence");
  const executable = await executableWithSource(directory, `
    let subscriptions = 0;
    const created_at = new Date().toISOString();
    const count = ${count};
    const messages = Array.from({ length: count }, (_, index) => ({
      id: index + 1, chat_id: 42, guid: "burst-" + (index + 1), created_at,
      is_from_me: true, service: "iMessage", text: "hello",
    }));
    ${rpcLoop(`
      let result = { ok: true };
      if (request.method === "initialize") result = {
        protocol_version: 1, version: "0.15.0",
        database: { path: ${JSON.stringify(databasePath)}, ready: true, features: { routing_metadata: true } },
        methods: ["initialize", "status", "chats.list", "messages.history", "messages.after", "messages.stats", "watch.subscribe", "watch.unsubscribe", "send"],
      };
      if (request.method === "messages.stats") result = { chats: [{ chat_id: 42, service: "iMessage" }], sent_messages: 1 };
      if (request.method === "messages.after") {
        const page = messages.filter((message) => message.id > request.params.since_rowid).slice(0, request.params.limit);
        result = { messages: page, next_rowid: page.at(-1)?.id ?? request.params.since_rowid,
          has_more: (page.at(-1)?.id ?? request.params.since_rowid) < count };
      }
      if (request.method === "watch.subscribe") result = { subscription: ++subscriptions };
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");
      if (request.method === "watch.subscribe" && subscriptions === 1) {
        for (const message of messages) process.stdout.write(JSON.stringify({ jsonrpc: "2.0",
          method: "message", params: { subscription: 1, message } }) + "\\n");
      }
    `)}
  `);
  const messages = createProntoMessages({ imsgPath: executable });
  const release = Promise.withResolvers<void>();
  const delivered: number[] = [];
  let overflows = 0;
  const subscription = await messages.subscribe({
    onEvent: async (event) => { delivered.push(event.message.rowId); await release.promise; },
    onOverflow: () => { overflows += 1; },
  });
  try {
    await Bun.sleep(100);
    expect(messages.diagnostics().pendingNotifications).toBeLessThanOrEqual(256);
    release.resolve();
    const deadline = Date.now() + 25_000;
    while (delivered.length < count && Date.now() < deadline) await Bun.sleep(10);
    expect(delivered).toEqual(Array.from({ length: count }, (_, index) => index + 1));
    expect(overflows).toBeGreaterThan(0);
  } finally {
    release.resolve();
    await subscription.close();
    await messages.close();
  }
}, 30_000);

test("skips stale recovery rows without hiding newer eligible rows", async () => {
  const directory = await fixtureDirectory();
  const databasePath = join(directory, "chat.db");
  const statePath = join(directory, "provider-state.json");
  await writeFile(databasePath, "database evidence");
  await new ProviderStateStore(statePath).advance(
    await databaseGeneration(databasePath),
    40,
    checkpointWitness(),
  );
  const oldDate = new Date(Date.now() - 25 * 60 * 60 * 1_000).toISOString();
  const recentDate = new Date().toISOString();
  const executable = await executableWithSource(directory, rpcLoop(`
    let result;
    if (request.method === "initialize") result = {
      protocol_version: 1,
      version: "0.14.1",
      database: { path: ${JSON.stringify(databasePath)}, ready: true, features: { routing_metadata: true } },
      methods: ["initialize", "status", "chats.list", "messages.history", "messages.after", "messages.stats", "watch.subscribe", "watch.unsubscribe", "send"],
    };
    else if (request.method === "messages.after" && request.params.since_rowid === 39) result = {
      has_more: false,
      messages: [{ guid: "checkpoint-guid", id: 40 }],
      next_rowid: 40,
    };
    else if (request.method === "messages.after") result = {
      has_more: false,
      messages: [
        { chat_id: 42, created_at: ${JSON.stringify(oldDate)}, guid: "old-guid", id: 41, is_from_me: false, service: "iMessage", text: "old" },
        { chat_id: 42, created_at: ${JSON.stringify(recentDate)}, guid: "new-guid", id: 42, is_from_me: false, service: "iMessage", text: "new" },
      ],
      next_rowid: 42,
    };
    else if (request.method === "messages.stats") result = { chats: [{ chat_id: 42, service: "iMessage" }], sent_messages: 1 };
    else if (request.method === "watch.subscribe") result = { subscription: 8 };
    else result = { ok: true };
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");
  `));
  const messages = createProntoMessages({ imsgPath: executable, statePath });
  const outcomes: MessagesRecoveryOutcome[] = [];
  const delivered: number[] = [];

  const subscription = await messages.subscribe({
    onEvent: (event) => { delivered.push(event.message.rowId); },
    onRecovery: (outcome) => { outcomes.push(outcome); },
  });
  expect(delivered).toEqual([42]);
  expect(outcomes).toEqual([{ rows: 2, status: "recovered" }]);
  expect(messages.diagnostics()).toMatchObject({ catchUpRows: 2, state: "ready" });
  await subscription.close();
  await messages.close();
});

test("suppresses a stale live notification and advances its checkpoint", async () => {
  const directory = await fixtureDirectory();
  const databasePath = join(directory, "chat.db");
  const statePath = join(directory, "provider-state.json");
  await writeFile(databasePath, "database evidence");
  const oldDate = new Date(Date.now() - 10 * 60 * 1_000).toISOString();
  const executable = await executableWithSource(directory, rpcLoop(`
    let result;
    if (request.method === "initialize") result = {
      protocol_version: 1,
      version: "0.15.0",
      database: { path: ${JSON.stringify(databasePath)}, ready: true, features: { routing_metadata: true } },
      methods: ["initialize", "status", "chats.list", "messages.history", "messages.after", "messages.stats", "watch.subscribe", "watch.unsubscribe", "send"],
    };
    else if (request.method === "watch.subscribe") result = { subscription: 18 };
    else result = { ok: true };
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");
    if (request.method === "watch.subscribe") {
      process.stdout.write(JSON.stringify({
        jsonrpc: "2.0",
        method: "message",
        params: {
          subscription: 18,
          message: { chat_id: 42, created_at: ${JSON.stringify(oldDate)}, guid: "stale-live-guid", id: 1, is_from_me: false, service: "iMessage", text: "stale" },
        },
      }) + "\\n");
    }
  `));
  const messages = createProntoMessages({ imsgPath: executable, statePath });
  const delivered: number[] = [];
  const subscription = await messages.subscribe({
    onEvent: (event) => { delivered.push(event.message.rowId); },
  });
  const generation = await databaseGeneration(databasePath);
  const deadline = Date.now() + 2_000;
  let checkpoint = await new ProviderStateStore(statePath).checkpoint(generation);
  while (checkpoint?.rowId !== 1 && Date.now() < deadline) {
    await Bun.sleep(20);
    checkpoint = await new ProviderStateStore(statePath).checkpoint(generation);
  }
  expect(delivered).toEqual([]);
  expect(checkpoint?.rowId).toBe(1);
  await subscription.close();
  await messages.close();
});

test("uses the watch replay sentinel for an adopted zero checkpoint", async () => {
  const directory = await fixtureDirectory();
  const databasePath = join(directory, "chat.db");
  const requestLog = join(directory, "requests.log");
  const statePath = join(directory, "provider-state.json");
  await writeFile(databasePath, "database evidence");
  const generation = await databaseGeneration(databasePath);
  await new ProviderStateStore(statePath).initialize(generation, 0);
  const executable = await executableWithSource(directory, `
import { appendFileSync } from "node:fs";
${rpcLoop(`
    appendFileSync(${JSON.stringify(requestLog)}, JSON.stringify(request) + "\\n");
    let result;
    if (request.method === "initialize") result = {
      protocol_version: 1,
      version: "0.15.0",
      database: { path: ${JSON.stringify(databasePath)}, ready: true, features: { routing_metadata: true } },
      methods: ["initialize", "status", "chats.list", "messages.history", "messages.after", "messages.stats", "watch.subscribe", "watch.unsubscribe", "send"],
    };
    else if (request.method === "messages.after") result = {
      has_more: false,
      messages: [],
      next_rowid: Number(request.params.since_rowid),
    };
    else if (request.method === "watch.subscribe") result = { subscription: 19 };
    else result = { ok: true };
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");
  `)}
  `);
  const messages = createProntoMessages({ imsgPath: executable, statePath });
  const subscription = await messages.subscribe({ onEvent: () => undefined });
  const requests = (await readFile(requestLog, "utf8")).trim().split("\n")
    .map((line) => JSON.parse(line));
  const history = requests.find((request) => request.method === "messages.after" &&
    request.params.since_rowid === 0);
  const watch = requests.find((request) => request.method === "watch.subscribe");
  expect(history).toBeDefined();
  expect(watch.params.since_rowid).toBe(-1);
  await subscription.close();
  await messages.close();
});

test("adopts a verified checkpoint from a compatible legacy generation", async () => {
  const directory = await fixtureDirectory();
  const databasePath = join(directory, "chat.db");
  const statePath = join(directory, "provider-state.json");
  await writeFile(databasePath, "database evidence");
  const metadata = await import("node:fs/promises").then(({ stat }) => stat(databasePath));
  const resolved = await import("node:fs/promises").then(({ realpath }) => realpath(databasePath));
  const legacyGeneration = createHash("sha256").update(JSON.stringify({
    path: resolved,
    device: String(metadata.dev),
    inode: String(metadata.ino),
    birthtime: metadata.birthtimeMs,
  })).digest("base64url");
  const executable = await executableWithSource(directory, rpcLoop(`
    let result;
    if (request.method === "initialize") result = {
      protocol_version: 1,
      version: "0.14.1",
      database: { path: ${JSON.stringify(databasePath)}, ready: true, features: { routing_metadata: true } },
      methods: ["initialize", "status", "chats.list", "messages.history", "messages.after", "messages.stats", "watch.subscribe", "watch.unsubscribe", "send"],
    };
    else if (request.method === "messages.after" && request.params.since_rowid === 39) result = {
      has_more: false,
      messages: [{ guid: "checkpoint-guid", id: 40 }],
      next_rowid: 40,
    };
    else result = { ok: true };
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");
  `));
  const messages = createProntoMessages({ imsgPath: executable, statePath });

  await expect(messages.adoptCheckpoint!({
    databaseGeneration: legacyGeneration,
    providerMessageId: "checkpoint-guid",
    rowId: 40,
    version: 1,
  })).resolves.toEqual({ status: "adopted" });
  await expect(messages.adoptCheckpoint!({
    databaseGeneration: legacyGeneration,
    providerMessageId: "newer-guid",
    rowId: 41,
    version: 1,
  })).resolves.toEqual({ status: "preserved" });
  expect(await new ProviderStateStore(statePath).checkpoint(
    await databaseGeneration(databasePath),
  )).toMatchObject({ rowId: 40 });
  await messages.close();

  const rejectedStatePath = join(directory, "rejected-provider-state.json");
  const rejected = createProntoMessages({ imsgPath: executable, statePath: rejectedStatePath });
  await expect(rejected.adoptCheckpoint!({
    databaseGeneration: "different-database-generation",
    providerMessageId: "checkpoint-guid",
    rowId: 40,
    version: 1,
  })).resolves.toEqual({
    reason: "database-generation-mismatch",
    status: "rejected",
  });
  expect(await new ProviderStateStore(rejectedStatePath).currentCheckpoint()).toBeUndefined();
  await rejected.close();

  const rebuiltStatePath = join(directory, "rebuilt-provider-state.json");
  const rebuilt = createProntoMessages({ imsgPath: executable, statePath: rebuiltStatePath });
  await expect(rebuilt.adoptCheckpoint!({
    databaseGeneration: legacyGeneration,
    providerMessageId: "guid-before-in-place-rebuild",
    rowId: 40,
    version: 1,
  })).resolves.toEqual({
    reason: "checkpoint-witness-unavailable",
    status: "rejected",
  });
  expect(await new ProviderStateStore(rebuiltStatePath).currentCheckpoint()).toBeUndefined();
  await rebuilt.close();
});

test("enforces row-count and wall-clock recovery bounds", async () => {
  const runBoundedRecovery = async (input: {
    readonly delayMs: number;
    readonly maxDurationMs: number;
    readonly maxRows: number;
    readonly rowCount: number;
  }): Promise<{ readonly outcome: MessagesRecoveryOutcome; readonly recoveryElapsedMs: number }> => {
    const directory = await fixtureDirectory();
    const catchUpStartedPath = join(directory, "catch-up-started.txt");
    const databasePath = join(directory, "chat.db");
    const statePath = join(directory, "provider-state.json");
    await writeFile(databasePath, "database evidence");
    await new ProviderStateStore(statePath).advance(
      await databaseGeneration(databasePath),
      40,
      checkpointWitness(),
    );
    const occurredAt = new Date().toISOString();
    const rows = Array.from({ length: input.rowCount }, (_, index) => ({
      chat_id: 42,
      created_at: occurredAt,
      guid: `guid-${index + 41}`,
      id: index + 41,
      is_from_me: true,
      service: "iMessage",
      text: "bounded",
    }));
    const executable = await executableWithSource(directory, `
import { writeFileSync } from "node:fs";
${rpcLoop(`
      let result;
      if (request.method === "initialize") result = {
        protocol_version: 1,
        version: "0.14.1",
        database: { path: ${JSON.stringify(databasePath)}, ready: true, features: { routing_metadata: true } },
        methods: ["initialize", "status", "chats.list", "messages.history", "messages.after", "messages.stats", "watch.subscribe", "watch.unsubscribe", "send"],
      };
      else if (request.method === "messages.after" && request.params.since_rowid === 39) result = {
        has_more: false,
        messages: [{ guid: "checkpoint-guid", id: 40 }],
        next_rowid: 40,
      };
      else if (request.method === "messages.after") {
        writeFileSync(${JSON.stringify(catchUpStartedPath)}, String(Date.now()));
        await Bun.sleep(${input.delayMs});
        result = { has_more: false, messages: ${JSON.stringify(rows)}, next_rowid: ${40 + input.rowCount} };
      } else if (request.method === "watch.subscribe") result = { subscription: 10 };
      else result = { ok: true };
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");
    `)}
    `);
    const messages = createProntoMessages({
      imsgPath: executable,
      recoveryLimits: {
        maxAgeMs: 60_000,
        maxDurationMs: input.maxDurationMs,
        maxRows: input.maxRows,
      },
      statePath,
    });
    const outcomes: MessagesRecoveryOutcome[] = [];
    let recoveryElapsedMs = 0;
    const subscription = await messages.subscribe({
      onEvent: () => undefined,
      onRecovery: async (outcome) => {
        outcomes.push(outcome);
        const catchUpStartedAt = Number(await readFile(catchUpStartedPath, "utf8"));
        recoveryElapsedMs = Date.now() - catchUpStartedAt;
      },
    });
    await subscription.close();
    await messages.close();
    return { outcome: outcomes[0]!, recoveryElapsedMs };
  };

  expect((await runBoundedRecovery({
    delayMs: 0,
    maxDurationMs: 1_000,
    maxRows: 1,
    rowCount: 2,
  })).outcome).toMatchObject({ reason: "row-limit", status: "degraded" });
  const duration = await runBoundedRecovery({
    delayMs: 500,
    maxDurationMs: 50,
    maxRows: 10,
    rowCount: 1,
  });
  expect(duration.outcome).toMatchObject({ reason: "duration-limit", status: "degraded" });
  expect(duration.recoveryElapsedMs).toBeLessThan(250);
});

test("never sends an old checkpoint to a replacement database generation", async () => {
  const directory = await fixtureDirectory();
  const databasePath = join(directory, "chat.db");
  const requestLog = join(directory, "requests.log");
  const statePath = join(directory, "provider-state.json");
  await writeFile(databasePath, "replacement database evidence");
  await new ProviderStateStore(statePath).advance("old-generation", 900);
  const executable = await executableWithSource(directory, `
import { appendFileSync } from "node:fs";
${rpcLoop(`
    appendFileSync(${JSON.stringify(requestLog)}, JSON.stringify(request) + "\\n");
    const result = request.method === "initialize" ? {
      protocol_version: 1,
      version: "0.14.1",
      database: { path: ${JSON.stringify(databasePath)}, ready: true, features: { routing_metadata: true } },
      methods: ["initialize", "status", "chats.list", "messages.history", "messages.after", "messages.stats", "watch.subscribe", "watch.unsubscribe", "send"],
    } : request.method === "watch.subscribe" ? { subscription: 9 } : { ok: true };
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");
  `)}
  `);
  const messages = createProntoMessages({ imsgPath: executable, statePath });
  const outcomes: MessagesRecoveryOutcome[] = [];
  const subscription = await messages.subscribe({
    onEvent: () => undefined,
    onRecovery: (outcome) => { outcomes.push(outcome); },
  });

  const requests = (await readFile(requestLog, "utf8")).trim().split("\n")
    .map((line) => JSON.parse(line));
  const watch = requests.find((request) => request.method === "watch.subscribe");
  expect(watch.params).not.toHaveProperty("since_rowid");
  expect(outcomes).toEqual([expect.objectContaining({
    reason: "database-generation-changed",
    status: "degraded",
  })]);
  const diagnostics = JSON.stringify(messages.diagnostics());
  expect(diagnostics).not.toContain(databasePath);
  expect(diagnostics).not.toContain("old-generation");
  expect(diagnostics).not.toContain("replacement database evidence");
  await subscription.close();
  await messages.close();
});

test("rejects an old checkpoint after an in-place database rebuild", async () => {
  const directory = await fixtureDirectory();
  const databasePath = join(directory, "chat.db");
  const requestLog = join(directory, "requests.log");
  const statePath = join(directory, "provider-state.json");
  await writeFile(databasePath, "same file identity after rebuild");
  const generation = await databaseGeneration(databasePath);
  await new ProviderStateStore(statePath).advance(generation, 40, {
    providerMessageDigest: "checkpoint-before-rebuild-digest",
    rowId: 40,
  });
  const occurredAt = new Date().toISOString();
  const executable = await executableWithSource(directory, `
import { appendFileSync } from "node:fs";
${rpcLoop(`
    appendFileSync(${JSON.stringify(requestLog)}, JSON.stringify(request) + "\\n");
    let result;
    if (request.method === "initialize") result = {
      protocol_version: 1,
      version: "0.14.1",
      database: { path: ${JSON.stringify(databasePath)}, ready: true, features: { routing_metadata: true } },
      methods: ["initialize", "status", "chats.list", "messages.history", "messages.after", "messages.stats", "watch.subscribe", "watch.unsubscribe", "send"],
    };
    else if (request.method === "messages.after" && request.params.since_rowid === 39) result = {
      has_more: false,
      messages: [{ chat_id: 42, created_at: ${JSON.stringify(occurredAt)}, guid: "different-message-after-rebuild", id: 40, is_from_me: true, service: "iMessage", text: "replacement" }],
      next_rowid: 40,
    };
    else if (request.method === "messages.after") result = {
      has_more: false,
      messages: [],
      next_rowid: request.params.since_rowid,
    };
    else if (request.method === "watch.subscribe") result = { subscription: 10 };
    else result = { ok: true };
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");
  `)}
  `);
  const messages = createProntoMessages({ imsgPath: executable, statePath });
  const outcomes: MessagesRecoveryOutcome[] = [];
  const subscription = await messages.subscribe({
    onEvent: () => undefined,
    onRecovery: (outcome) => { outcomes.push(outcome); },
  });

  const requests = (await readFile(requestLog, "utf8")).trim().split("\n")
    .map((line) => JSON.parse(line));
  const watch = requests.find((request) => request.method === "watch.subscribe");
  expect(watch.params).not.toHaveProperty("since_rowid");
  expect(outcomes).toContainEqual(expect.objectContaining({
    reason: "database-generation-changed",
    status: "degraded",
  }));
  await subscription.close();
  await messages.close();
});

test("rejects a same-file snapshot rolled back behind the checkpoint", async () => {
  const directory = await fixtureDirectory();
  const databasePath = join(directory, "chat.db");
  const requestLog = join(directory, "requests.log");
  const statePath = join(directory, "provider-state.json");
  await writeFile(databasePath, "same file identity after snapshot restore");
  const generation = await databaseGeneration(databasePath);
  const store = new ProviderStateStore(statePath);
  for (let rowId = 97; rowId <= 100; rowId += 1) {
    await store.advance(generation, rowId, checkpointWitness(rowId, `guid-${rowId}`));
  }
  const executable = await executableWithSource(directory, `
import { appendFileSync } from "node:fs";
${rpcLoop(`
    appendFileSync(${JSON.stringify(requestLog)}, JSON.stringify(request) + "\\n");
    let result;
    if (request.method === "initialize") result = {
      protocol_version: 1,
      version: "0.14.1",
      database: { path: ${JSON.stringify(databasePath)}, ready: true, features: { routing_metadata: true } },
      methods: ["initialize", "status", "chats.list", "messages.history", "messages.after", "messages.stats", "watch.subscribe", "watch.unsubscribe", "send"],
    };
    else if (request.method === "messages.after" && request.params.since_rowid === 97) result = {
      has_more: false,
      messages: [{ guid: "guid-98", id: 98 }],
      next_rowid: 98,
    };
    else if (request.method === "messages.after") result = { has_more: false, messages: [], next_rowid: request.params.since_rowid };
    else if (request.method === "watch.subscribe") result = { subscription: 10 };
    else result = { ok: true };
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");
  `)}
  `);
  const messages = createProntoMessages({ imsgPath: executable, statePath });
  const outcomes: MessagesRecoveryOutcome[] = [];
  const subscription = await messages.subscribe({
    onEvent: () => undefined,
    onRecovery: (outcome) => { outcomes.push(outcome); },
  });

  const requests = (await readFile(requestLog, "utf8")).trim().split("\n")
    .map((line) => JSON.parse(line));
  const watch = requests.find((request) => request.method === "watch.subscribe");
  expect(watch.params).not.toHaveProperty("since_rowid");
  expect(outcomes).toContainEqual(expect.objectContaining({
    reason: "database-generation-changed",
    status: "degraded",
  }));
  await subscription.close();
  await messages.close();
});

test("fails closed for a generation checkpoint without a message witness", async () => {
  const directory = await fixtureDirectory();
  const databasePath = join(directory, "chat.db");
  const requestLog = join(directory, "requests.log");
  const statePath = join(directory, "provider-state.json");
  await writeFile(databasePath, "database evidence");
  const generation = await databaseGeneration(databasePath);
  await new ProviderStateStore(statePath).advance(generation, 40);
  const executable = await executableWithSource(directory, `
import { appendFileSync } from "node:fs";
${rpcLoop(`
    appendFileSync(${JSON.stringify(requestLog)}, JSON.stringify(request) + "\\n");
    const result = request.method === "initialize" ? {
      protocol_version: 1,
      version: "0.14.1",
      database: { path: ${JSON.stringify(databasePath)}, ready: true, features: { routing_metadata: true } },
      methods: ["initialize", "status", "chats.list", "messages.history", "messages.after", "messages.stats", "watch.subscribe", "watch.unsubscribe", "send"],
    } : request.method === "watch.subscribe" ? { subscription: 11 } : { ok: true };
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");
  `)}
  `);
  const messages = createProntoMessages({ imsgPath: executable, statePath });
  const outcomes: MessagesRecoveryOutcome[] = [];
  const subscription = await messages.subscribe({
    onEvent: () => undefined,
    onRecovery: (outcome) => { outcomes.push(outcome); },
  });

  const requests = (await readFile(requestLog, "utf8")).trim().split("\n")
    .map((line) => JSON.parse(line));
  const watch = requests.find((request) => request.method === "watch.subscribe");
  expect(watch.params).not.toHaveProperty("since_rowid");
  expect(outcomes).toContainEqual(expect.objectContaining({
    reason: "database-generation-changed",
    status: "degraded",
  }));
  await subscription.close();
  await messages.close();
});

test("continues recovery when the witnessed message was deleted", async () => {
  const directory = await fixtureDirectory();
  const databasePath = join(directory, "chat.db");
  const requestLog = join(directory, "requests.log");
  const statePath = join(directory, "provider-state.json");
  await writeFile(databasePath, "database evidence");
  const generation = await databaseGeneration(databasePath);
  await new ProviderStateStore(statePath).advance(generation, 39, {
    providerMessageDigest: createHash("sha256").update("surviving-guid").digest("base64url"),
    rowId: 39,
  });
  await new ProviderStateStore(statePath).advance(generation, 40, {
    providerMessageDigest: createHash("sha256").update("deleted-guid").digest("base64url"),
    rowId: 40,
  });
  const occurredAt = new Date().toISOString();
  const executable = await executableWithSource(directory, `
import { appendFileSync } from "node:fs";
${rpcLoop(`
    appendFileSync(${JSON.stringify(requestLog)}, JSON.stringify(request) + "\\n");
    let result;
    if (request.method === "initialize") result = {
      protocol_version: 1,
      version: "0.14.1",
      database: { path: ${JSON.stringify(databasePath)}, ready: true, features: { routing_metadata: true } },
      methods: ["initialize", "status", "chats.list", "messages.history", "messages.after", "messages.stats", "watch.subscribe", "watch.unsubscribe", "send"],
    };
    else if (request.method === "messages.after" && request.params.since_rowid === 38) result = {
      has_more: false,
      messages: [{ guid: "surviving-guid", id: 39 }],
      next_rowid: 39,
    };
    else if (request.method === "messages.after") result = {
      has_more: false,
      messages: [{ chat_id: 42, created_at: ${JSON.stringify(occurredAt)}, guid: "future-guid", id: 41, is_from_me: true, service: "iMessage", text: "future" }],
      next_rowid: 41,
    };
    else if (request.method === "messages.stats") result = { chats: [{ chat_id: 42, service: "iMessage" }], sent_messages: 1 };
    else if (request.method === "watch.subscribe") result = { subscription: 12 };
    else result = { ok: true };
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");
  `)}
  `);
  const messages = createProntoMessages({ imsgPath: executable, statePath });
  const rowIds: number[] = [];
  const outcomes: MessagesRecoveryOutcome[] = [];
  const subscription = await messages.subscribe({
    onEvent: (event) => { rowIds.push(event.message.rowId); },
    onRecovery: (outcome) => { outcomes.push(outcome); },
  });

  const requests = (await readFile(requestLog, "utf8")).trim().split("\n")
    .map((line) => JSON.parse(line));
  const watch = requests.find((request) => request.method === "watch.subscribe");
  expect(rowIds).toEqual([41]);
  expect(outcomes).not.toContainEqual(expect.objectContaining({
    reason: "database-generation-changed",
  }));
  expect(watch.params.since_rowid).toBe(41);
  await subscription.close();
  await messages.close();
});

test("discards a catch-up page when the database changes while the request is in flight", async () => {
  const directory = await fixtureDirectory();
  const databasePath = join(directory, "chat.db");
  const pageStartedPath = join(directory, "page-started.txt");
  const requestLog = join(directory, "requests.log");
  const statePath = join(directory, "provider-state.json");
  await writeFile(databasePath, "first database evidence");
  await new ProviderStateStore(statePath).advance(
    await databaseGeneration(databasePath),
    40,
    checkpointWitness(),
  );
  const occurredAt = new Date().toISOString();
  const executable = await executableWithSource(directory, `
import { appendFileSync, writeFileSync } from "node:fs";
${rpcLoop(`
    appendFileSync(${JSON.stringify(requestLog)}, JSON.stringify(request) + "\\n");
    let result;
    if (request.method === "initialize") result = {
      protocol_version: 1,
      version: "0.14.1",
      database: { path: ${JSON.stringify(databasePath)}, ready: true, features: { routing_metadata: true } },
      methods: ["initialize", "status", "chats.list", "messages.history", "messages.after", "messages.stats", "watch.subscribe", "watch.unsubscribe", "send"],
    };
    else if (request.method === "messages.after" && request.params.since_rowid === 39) result = {
      has_more: false,
      messages: [{ guid: "checkpoint-guid", id: 40 }],
      next_rowid: 40,
    };
    else if (request.method === "messages.after") {
      writeFileSync(${JSON.stringify(pageStartedPath)}, "started");
      await Bun.sleep(200);
      result = {
        has_more: false,
        messages: [{ chat_id: 42, created_at: ${JSON.stringify(occurredAt)}, guid: "old-page", id: 41, is_from_me: true, service: "iMessage", text: "must not escape" }],
        next_rowid: 41,
      };
    } else if (request.method === "watch.subscribe") result = { subscription: 12 };
    else result = { ok: true };
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");
  `)}
  `);
  const messages = createProntoMessages({ imsgPath: executable, statePath });
  const rowIds: number[] = [];
  const outcomes: MessagesRecoveryOutcome[] = [];
  const subscriptionPromise = messages.subscribe({
    onEvent: (event) => { rowIds.push(event.message.rowId); },
    onRecovery: (outcome) => { outcomes.push(outcome); },
  });
  const markerDeadline = Date.now() + 3_000;
  let pageStarted = false;
  while (!pageStarted && Date.now() < markerDeadline) {
    pageStarted = await readFile(pageStartedPath, "utf8").then(() => true, () => false);
    if (!pageStarted) await Bun.sleep(10);
  }
  expect(pageStarted).toBe(true);
  const replacement = join(directory, "replacement.db");
  await writeFile(replacement, "second database evidence");
  await rename(replacement, databasePath);

  const subscription = await subscriptionPromise;
  expect(rowIds).toEqual([]);
  expect(outcomes).toContainEqual(expect.objectContaining({
    reason: "database-generation-changed",
    status: "degraded",
  }));
  const requests = (await readFile(requestLog, "utf8")).trim().split("\n")
    .map((line) => JSON.parse(line));
  const replacementWatch = [...requests].reverse()
    .find((request: Record<string, any>) => request.method === "watch.subscribe");
  expect(replacementWatch.params).not.toHaveProperty("since_rowid");
  await subscription.close();
  await messages.close();
}, 5_000);

test("detects a database replacement while the provider process remains live", async () => {
  const directory = await fixtureDirectory();
  const databasePath = join(directory, "chat.db");
  const statePath = join(directory, "provider-state.json");
  await writeFile(databasePath, "first database evidence");
  const occurredAt = new Date().toISOString();
  const executable = await executableWithSource(directory, `
let subscriptions = 0;
${rpcLoop(`
    let result;
    if (request.method === "initialize") result = {
      protocol_version: 1,
      version: "0.14.1",
      database: { path: ${JSON.stringify(databasePath)}, ready: true, features: { routing_metadata: true } },
      methods: ["initialize", "status", "chats.list", "messages.history", "messages.after", "messages.stats", "watch.subscribe", "watch.unsubscribe", "send"],
    };
    else if (request.method === "watch.subscribe") {
      subscriptions += 1;
      result = { subscription: subscriptions };
    } else if (request.method === "messages.stats") result = { chats: [{ chat_id: 42, service: "iMessage" }], sent_messages: 1 };
    else result = { ok: true };
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");
    if (request.method === "watch.subscribe" && subscriptions === 1) {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "message", params: { subscription: 1, message: { chat_id: 42, created_at: ${JSON.stringify(occurredAt)}, guid: "guid-1", id: 1, is_from_me: true, service: "iMessage", text: "first" } } }) + "\\n");
    }
    if (request.method === "watch.subscribe" && subscriptions === 2) {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "message", params: { subscription: 2, message: { chat_id: 42, created_at: ${JSON.stringify(occurredAt)}, guid: "guid-2", id: 2, is_from_me: true, service: "iMessage", text: "second" } } }) + "\\n");
    }
  `)}
  `);
  const messages = createProntoMessages({ imsgPath: executable, statePath });
  const rowIds: number[] = [];
  const outcomes: MessagesRecoveryOutcome[] = [];
  const subscription = await messages.subscribe({
    onEvent: async (event) => {
      rowIds.push(event.message.rowId);
      if (event.message.rowId === 1) {
        const replacement = join(directory, "replacement.db");
        await writeFile(replacement, "second database evidence");
        await rename(replacement, databasePath);
      }
    },
    onRecovery: (outcome) => { outcomes.push(outcome); },
  });
  const deadline = Date.now() + 3_000;
  while ((rowIds.length < 2 || outcomes.length < 1) && Date.now() < deadline) {
    await Bun.sleep(20);
  }

  expect(rowIds).toEqual([1, 2]);
  expect(outcomes).toContainEqual(expect.objectContaining({
    reason: "database-generation-changed",
    status: "degraded",
  }));
  await subscription.close();
  await messages.close();
}, 5_000);

test("does not publish enriched routing facts across database generations", async () => {
  const directory = await fixtureDirectory();
  const databasePath = join(directory, "chat.db");
  await writeFile(databasePath, "first database evidence");
  const occurredAt = new Date().toISOString();
  const executable = await executableWithSource(directory, `
import { renameSync, writeFileSync } from "node:fs";
let subscriptions = 0;
let replaced = false;
${rpcLoop(`
    let result;
    if (request.method === "initialize") result = {
      protocol_version: 1,
      version: "0.14.1",
      database: { path: ${JSON.stringify(databasePath)}, ready: true, features: { routing_metadata: true } },
      methods: ["initialize", "status", "chats.list", "messages.history", "messages.after", "messages.stats", "watch.subscribe", "watch.unsubscribe", "send"],
    };
    else if (request.method === "watch.subscribe") {
      subscriptions += 1;
      result = { subscription: subscriptions };
    } else if (request.method === "messages.stats") {
      result = { chats: [{ chat_id: 42, service: "RCS" }], sent_messages: 1 };
    } else if (request.method === "chats.list") {
      if (!replaced) {
        replaced = true;
        writeFileSync(${JSON.stringify(databasePath)} + ".replacement", "second database evidence");
        renameSync(${JSON.stringify(databasePath)} + ".replacement", ${JSON.stringify(databasePath)});
      }
      result = { chats: [{
        account_id: "E:owner@example.com",
        account_login: "owner@example.com",
        guid: "RCS;-;+15550000000",
        id: 42,
        is_group: false,
        last_addressed_handle: "+15551111111",
        service: "RCS",
      }] };
    } else result = { ok: true };
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");
    if (request.method === "watch.subscribe" && subscriptions === 1) {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "message", params: {
        subscription: 1,
        message: {
          chat_id: 42,
          chat_guid: "RCS;-;+15550000000",
          created_at: ${JSON.stringify(occurredAt)},
          guid: "old-generation-guid",
          id: 1,
          is_from_me: false,
          is_group: false,
          participants: ["+15550000000", "+15551111111"],
          sender: "+15550000000",
          service: "RCS",
          text: "must not escape",
        },
      } }) + "\\n");
    }
  `)}
  `);
  const messages = createProntoMessages({ imsgPath: executable });
  const deliveredRowIds: number[] = [];
  const outcomes: MessagesRecoveryOutcome[] = [];
  const subscription = await messages.subscribe({
    onEvent: (event) => { deliveredRowIds.push(event.message.rowId); },
    onRecovery: (outcome) => { outcomes.push(outcome); },
  });
  const deadline = Date.now() + 3_000;
  while (outcomes.length < 1 && Date.now() < deadline) await Bun.sleep(20);

  expect(deliveredRowIds).toEqual([]);
  expect(outcomes).toContainEqual(expect.objectContaining({
    reason: "database-generation-changed",
    status: "degraded",
  }));
  await subscription.close();
  await messages.close();
}, 5_000);

test("discards an old-watch notification after observing a new database generation", async () => {
  const directory = await fixtureDirectory();
  const databasePath = join(directory, "chat.db");
  await writeFile(databasePath, "first database evidence");
  const occurredAt = new Date().toISOString();
  const executable = await executableWithSource(directory, `
let subscriptions = 0;
${rpcLoop(`
    let result;
    if (request.method === "initialize") result = {
      protocol_version: 1,
      version: "0.14.1",
      database: { path: ${JSON.stringify(databasePath)}, ready: true, features: { routing_metadata: true } },
      methods: ["initialize", "status", "chats.list", "messages.history", "messages.after", "messages.stats", "watch.subscribe", "watch.unsubscribe", "send"],
    };
    else if (request.method === "watch.subscribe") {
      subscriptions += 1;
      result = { subscription: subscriptions };
    } else if (request.method === "messages.stats") result = { chats: [{ chat_id: 42, service: "iMessage" }], sent_messages: 1 };
    else result = { ok: true };
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");
    if (request.method === "watch.subscribe" && subscriptions === 1) {
      setTimeout(() => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "message", params: { subscription: 1, message: { chat_id: 42, created_at: ${JSON.stringify(occurredAt)}, guid: "old-watch", id: 900, is_from_me: true, service: "iMessage", text: "old generation" } } }) + "\\n"), 250);
    }
    if (request.method === "watch.subscribe" && subscriptions === 2) {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "message", params: { subscription: 2, message: { chat_id: 42, created_at: ${JSON.stringify(occurredAt)}, guid: "new-watch", id: 1, is_from_me: true, service: "iMessage", text: "new generation" } } }) + "\\n");
    }
  `)}
  `);
  const messages = createProntoMessages({ imsgPath: executable });
  const rowIds: number[] = [];
  const outcomes: MessagesRecoveryOutcome[] = [];
  const subscription = await messages.subscribe({
    onEvent: (event) => { rowIds.push(event.message.rowId); },
    onRecovery: (outcome) => { outcomes.push(outcome); },
  });
  const replacement = join(directory, "replacement.db");
  await writeFile(replacement, "second database evidence");
  await rename(replacement, databasePath);
  const deadline = Date.now() + 3_000;
  while ((rowIds.length < 1 || outcomes.length < 1) && Date.now() < deadline) {
    await Bun.sleep(20);
  }

  expect(rowIds).toEqual([1]);
  expect(outcomes).toContainEqual(expect.objectContaining({
    reason: "database-generation-changed",
    status: "degraded",
  }));
  await subscription.close();
  await messages.close();
}, 5_000);

test("suppresses a live duplicate while a timed-out catch-up callback is still running", async () => {
  const directory = await fixtureDirectory();
  const databasePath = join(directory, "chat.db");
  const statePath = join(directory, "provider-state.json");
  await writeFile(databasePath, "stable database evidence");
  const generation = await databaseGeneration(databasePath);
  await new ProviderStateStore(statePath).advance(generation, 40, checkpointWitness());
  const occurredAt = new Date().toISOString();
  const row = { chat_id: 42, created_at: occurredAt, guid: "guid-41", id: 41, is_from_me: true, service: "iMessage", text: "once" };
  const executable = await executableWithSource(directory, rpcLoop(`
    let result;
    if (request.method === "initialize") result = {
      protocol_version: 1,
      version: "0.14.1",
      database: { path: ${JSON.stringify(databasePath)}, ready: true, features: { routing_metadata: true } },
      methods: ["initialize", "status", "chats.list", "messages.history", "messages.after", "messages.stats", "watch.subscribe", "watch.unsubscribe", "send"],
    };
    else if (request.method === "messages.after" && request.params.since_rowid === 39) result = { has_more: false, messages: [{ guid: "checkpoint-guid", id: 40 }], next_rowid: 40 };
    else if (request.method === "messages.after") result = { has_more: false, messages: [${JSON.stringify(row)}], next_rowid: 41 };
    else if (request.method === "messages.stats") result = { chats: [{ chat_id: 42, service: "iMessage" }], sent_messages: 1 };
    else if (request.method === "watch.subscribe") result = { subscription: 14 };
    else result = { ok: true };
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");
    if (request.method === "watch.subscribe") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "message", params: { subscription: 14, message: ${JSON.stringify(row)} } }) + "\\n");
    }
  `));
  const messages = createProntoMessages({
    imsgPath: executable,
    recoveryLimits: { maxAgeMs: 60_000, maxDurationMs: 50, maxRows: 10 },
    statePath,
  });
  let deliveryCalls = 0;
  let finishDelivery!: () => void;
  const deliveryGate = new Promise<void>((resolve) => { finishDelivery = resolve; });
  const outcomes: MessagesRecoveryOutcome[] = [];
  const subscription = await messages.subscribe({
    onEvent: async () => {
      deliveryCalls += 1;
      await deliveryGate;
    },
    onRecovery: (outcome) => { outcomes.push(outcome); },
  });
  await Bun.sleep(100);
  expect(outcomes).toContainEqual(expect.objectContaining({
    reason: "duration-limit",
    status: "degraded",
  }));
  expect(deliveryCalls).toBe(1);
  finishDelivery();
  const checkpointDeadline = Date.now() + 2_000;
  let checkpoint = await new ProviderStateStore(statePath).checkpoint(generation);
  while (checkpoint?.rowId !== 41 && Date.now() < checkpointDeadline) {
    await Bun.sleep(20);
    checkpoint = await new ProviderStateStore(statePath).checkpoint(generation);
  }
  expect(checkpoint?.rowId).toBe(41);
  await subscription.close();
  await messages.close();
}, 5_000);

test("retries a rejected live delivery before allowing a higher row to advance", async () => {
  const directory = await fixtureDirectory();
  const databasePath = join(directory, "chat.db");
  const statePath = join(directory, "provider-state.json");
  await writeFile(databasePath, "stable database evidence");
  const occurredAt = new Date().toISOString();
  const first = { chat_id: 42, created_at: occurredAt, guid: "guid-1", id: 1, is_from_me: true, service: "iMessage", text: "first" };
  const second = { chat_id: 42, created_at: occurredAt, guid: "guid-2", id: 2, is_from_me: true, service: "iMessage", text: "second" };
  const executable = await executableWithSource(directory, `
let subscriptions = 0;
${rpcLoop(`
    let result;
    if (request.method === "initialize") result = {
      protocol_version: 1,
      version: "0.14.1",
      database: { path: ${JSON.stringify(databasePath)}, ready: true, features: { routing_metadata: true } },
      methods: ["initialize", "status", "chats.list", "messages.history", "messages.after", "messages.stats", "watch.subscribe", "watch.unsubscribe", "send"],
    };
    else if (request.method === "messages.after" && request.params.since_rowid === 39) result = {
      has_more: false,
      messages: [{ guid: "checkpoint-guid", id: 40 }],
      next_rowid: 40,
    };
    else if (request.method === "messages.after") {
      const since = Number(request.params.since_rowid);
      result = since === 0
        ? { has_more: false, messages: [${JSON.stringify(first)}], next_rowid: 1 }
        : since === 1
          ? { has_more: false, messages: [${JSON.stringify(second)}], next_rowid: 2 }
          : { has_more: false, messages: [], next_rowid: since };
    } else if (request.method === "messages.stats") result = { chats: [{ chat_id: 42, service: "iMessage" }], sent_messages: 1 };
    else if (request.method === "watch.subscribe") {
      subscriptions += 1;
      result = { subscription: subscriptions };
    } else result = { ok: true };
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");
    if (request.method === "watch.subscribe" && subscriptions === 1) {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "message", params: { subscription: 1, message: ${JSON.stringify(first)} } }) + "\\n");
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "message", params: { subscription: 1, message: ${JSON.stringify(second)} } }) + "\\n");
    }
  `)}
  `);
  const messages = createProntoMessages({ imsgPath: executable, statePath });
  const attempts: number[] = [];
  let firstAttempts = 0;
  const subscription = await messages.subscribe({
    onEvent: (event) => {
      attempts.push(event.message.rowId);
      if (event.message.rowId === 1 && firstAttempts++ === 0) {
        throw new Error("transient consumer failure");
      }
    },
  });
  const deadline = Date.now() + 4_000;
  let checkpoint = await new ProviderStateStore(statePath)
    .checkpoint(await databaseGeneration(databasePath));
  while (checkpoint?.rowId !== 2 && Date.now() < deadline) {
    await Bun.sleep(20);
    checkpoint = await new ProviderStateStore(statePath)
      .checkpoint(await databaseGeneration(databasePath));
  }

  expect(attempts).toEqual([1, 1, 2]);
  expect(checkpoint?.rowId).toBe(2);
  expect(messages.diagnostics().state).toBe("ready");
  await subscription.close();
  await messages.close();
}, 6_000);

test("retries transient catch-up and resubscribe failures after terminal overflow", async () => {
  const directory = await fixtureDirectory();
  const databasePath = join(directory, "chat.db");
  const statePath = join(directory, "provider-state.json");
  await writeFile(databasePath, "stable database evidence");
  await new ProviderStateStore(statePath).advance(
    await databaseGeneration(databasePath),
    40,
    checkpointWitness(),
  );
  const occurredAt = new Date().toISOString();
  const row = { chat_id: 42, created_at: occurredAt, guid: "guid-41", id: 41, is_from_me: true, service: "iMessage", text: "recovered" };
  const executable = await executableWithSource(directory, `
let afterCalls = 0;
let watchCalls = 0;
${rpcLoop(`
    let result;
    if (request.method === "initialize") result = {
      protocol_version: 1,
      version: "0.14.1",
      database: { path: ${JSON.stringify(databasePath)}, ready: true, features: { routing_metadata: true } },
      methods: ["initialize", "status", "chats.list", "messages.history", "messages.after", "messages.stats", "watch.subscribe", "watch.unsubscribe", "send"],
    };
    else if (request.method === "messages.after" && request.params.since_rowid === 39) result = {
      has_more: false,
      messages: [{ guid: "checkpoint-guid", id: 40 }],
      next_rowid: 40,
    };
    else if (request.method === "messages.after" && request.params.since_rowid === 40 && afterCalls >= 3) result = {
      has_more: false,
      messages: [${JSON.stringify(row)}],
      next_rowid: 41,
    };
    else if (request.method === "messages.after") {
      afterCalls += 1;
      if (afterCalls === 2) {
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message: "transient catch-up failure" } }) + "\\n");
        continue;
      }
      const since = Number(request.params.since_rowid);
      result = afterCalls === 3
        ? { has_more: false, messages: [${JSON.stringify(row)}], next_rowid: 41 }
        : { has_more: false, messages: [], next_rowid: since };
    } else if (request.method === "messages.stats") result = { chats: [{ chat_id: 42, service: "iMessage" }], sent_messages: 1 };
    else if (request.method === "watch.subscribe") {
      watchCalls += 1;
      if (watchCalls === 2) {
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message: "transient resubscribe failure" } }) + "\\n");
        continue;
      }
      result = { subscription: watchCalls };
    } else result = { ok: true };
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");
    if (request.method === "watch.subscribe" && watchCalls === 1) {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "watch.overflow", params: { subscription: 1, terminal: true, resume_after_rowid: 40 } }) + "\\n");
    }
  `)}
  `);
  const messages = createProntoMessages({ imsgPath: executable, statePath });
  const outcomes: MessagesRecoveryOutcome[] = [];
  const rowIds: number[] = [];
  let overflows = 0;
  const subscription = await messages.subscribe({
    onEvent: (event) => { rowIds.push(event.message.rowId); },
    onOverflow: () => { overflows += 1; },
    onRecovery: (outcome) => { outcomes.push(outcome); },
  });
  const deadline = Date.now() + 5_000;
  while (
    (rowIds.length < 1 || messages.diagnostics().state !== "ready") &&
    Date.now() < deadline
  ) {
    await Bun.sleep(20);
  }

  expect(overflows).toBe(1);
  expect(rowIds).toEqual([41]);
  expect(outcomes).toContainEqual(expect.objectContaining({
    reason: "provider-unavailable",
    status: "degraded",
  }));
  expect(messages.diagnostics().state).toBe("ready");
  await subscription.close();
  await messages.close();
}, 7_000);

test("coalesced recovery replaces every watch when the provider dies during overflow catch-up", async () => {
  const directory = await fixtureDirectory();
  const counterPath = join(directory, "starts.txt");
  const databasePath = join(directory, "chat.db");
  const requestLog = join(directory, "requests.log");
  const statePath = join(directory, "provider-state.json");
  await writeFile(databasePath, "stable database evidence");
  await new ProviderStateStore(statePath).advance(
    await databaseGeneration(databasePath),
    40,
    checkpointWitness(),
  );
  const executable = await executableWithSource(directory, `
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
const counterPath = ${JSON.stringify(counterPath)};
const run = existsSync(counterPath) ? Number(readFileSync(counterPath, "utf8")) + 1 : 1;
writeFileSync(counterPath, String(run));
let afterCalls = 0;
let watchCalls = 0;
${rpcLoop(`
    appendFileSync(${JSON.stringify(requestLog)}, JSON.stringify({ kind: "request", run, ...request }) + "\\n");
    let result;
    if (request.method === "initialize") result = {
      protocol_version: 1,
      version: "0.14.1",
      database: { path: ${JSON.stringify(databasePath)}, ready: true, features: { routing_metadata: true } },
      methods: ["initialize", "status", "chats.list", "messages.history", "messages.after", "messages.stats", "watch.subscribe", "watch.unsubscribe", "send"],
    };
    else if (request.method === "messages.after") {
      afterCalls += 1;
      if (run === 1 && afterCalls === 2) process.exit(0);
      result = { has_more: false, messages: [], next_rowid: Number(request.params.since_rowid) };
    } else if (request.method === "watch.subscribe") {
      watchCalls += 1;
      const subscription = run * 100 + watchCalls;
      appendFileSync(${JSON.stringify(requestLog)}, JSON.stringify({ kind: "created", run, subscription }) + "\\n");
      result = { subscription };
    } else result = { ok: true };
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");
    if (run === 1 && request.method === "watch.subscribe") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "watch.overflow", params: { subscription: 101, terminal: true, resume_after_rowid: 40 } }) + "\\n");
    }
  `)}
  `);
  const messages = createProntoMessages({ imsgPath: executable, statePath });
  const subscription = await messages.subscribe({
    onEvent: () => undefined,
    onOverflow: () => undefined,
  });
  const recoveryDeadline = Date.now() + 7_000;
  let createdOnReplacement: number[] = [];
  while (createdOnReplacement.length < 2 && Date.now() < recoveryDeadline) {
    const log = await readFile(requestLog, "utf8").catch(() => "");
    createdOnReplacement = log.trim().split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((entry) => entry.kind === "created" && entry.run === 2)
      .map((entry) => entry.subscription);
    if (createdOnReplacement.length < 2) await Bun.sleep(20);
  }
  expect(createdOnReplacement).toEqual([201, 202]);

  await subscription.close();
  const entries = (await readFile(requestLog, "utf8")).trim().split("\n")
    .map((line) => JSON.parse(line));
  const replacementUnsubscribes = entries
    .filter((entry) => entry.kind === "request" && entry.run === 2 && entry.method === "watch.unsubscribe")
    .map((entry) => entry.params.subscription);
  expect(replacementUnsubscribes).toEqual([201, 202]);
  await messages.close();
}, 10_000);

test("retries a transient resubscribe failure after catching up from its generation checkpoint", async () => {
  const directory = await fixtureDirectory();
  const counterPath = join(directory, "starts.txt");
  const databasePath = join(directory, "chat.db");
  const statePath = join(directory, "provider-state.json");
  await writeFile(databasePath, "stable database evidence");
  const occurredAt = new Date().toISOString();
  const executable = await executableWithSource(directory, `
import { existsSync, readFileSync, writeFileSync } from "node:fs";
const counterPath = ${JSON.stringify(counterPath)};
const run = existsSync(counterPath) ? Number(readFileSync(counterPath, "utf8")) + 1 : 1;
writeFileSync(counterPath, String(run));
let exitScheduled = false;
let watchAttempts = 0;
${rpcLoop(`
    let result;
    if (request.method === "initialize") result = {
      protocol_version: 1,
      version: "0.14.1",
      database: { path: ${JSON.stringify(databasePath)}, ready: true, features: { routing_metadata: true } },
      methods: ["initialize", "status", "chats.list", "messages.history", "messages.after", "messages.stats", "watch.subscribe", "watch.unsubscribe", "send"],
    };
    else if (request.method === "watch.subscribe") {
      watchAttempts += 1;
      if (run === 2 && watchAttempts === 1) {
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message: "transient subscribe failure" } }) + "\\n");
        continue;
      }
      result = { subscription: run };
    }
    else if (request.method === "messages.stats") result = { chats: [{ chat_id: 42, service: "iMessage" }], sent_messages: 1 };
    else if (request.method === "messages.after") {
      const since = Number(request.params.since_rowid);
      result = run > 1 && since === 100
        ? { has_more: false, messages: [{ chat_id: 42, created_at: ${JSON.stringify(occurredAt)}, guid: "guid-101", id: 101, is_from_me: true, service: "iMessage", text: "first" }], next_rowid: 101 }
        : run > 1 && since === 101
          ? { has_more: false, messages: [{ chat_id: 42, created_at: ${JSON.stringify(occurredAt)}, guid: "guid-102", id: 102, is_from_me: true, service: "iMessage", text: "second" }], next_rowid: 102 }
          : { has_more: false, messages: [], next_rowid: since };
    } else result = { ok: true };
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");
    if (run === 1 && request.method === "messages.stats" && !exitScheduled) {
      exitScheduled = true;
      setTimeout(() => process.exit(0), 100);
    }
    if (request.method === "watch.subscribe" && run === 1) {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "message", params: { subscription: run, message: { chat_id: 42, created_at: ${JSON.stringify(occurredAt)}, guid: "guid-101", id: 101, is_from_me: true, service: "iMessage", text: "first" } } }) + "\\n");
    }
  `)}
  `);
  const messages = createProntoMessages({ imsgPath: executable, statePath });
  const rowIds: number[] = [];
  const recoveries: MessagesRecoveryOutcome[] = [];
  const subscription = await messages.subscribe({
    onEvent: (event) => { rowIds.push(event.message.rowId); },
    onRecovery: (outcome) => { recoveries.push(outcome); },
  });

  const deadline = Date.now() + 5_000;
  while (
    (rowIds.length < 2 || recoveries.length < 1 || messages.diagnostics().state !== "ready") &&
    Date.now() < deadline
  ) {
    await Bun.sleep(20);
  }
  expect(rowIds).toEqual([101, 102]);
  expect(recoveries).toContainEqual({ rows: 1, status: "recovered" });
  expect(messages.diagnostics()).toMatchObject({ restartCount: 1, state: "ready" });
  await subscription.close();
  await messages.close();
}, 10_000);

test("close during restart unsubscribes a replacement watch created in flight", async () => {
  const directory = await fixtureDirectory();
  const counterPath = join(directory, "starts.txt");
  const databasePath = join(directory, "chat.db");
  const requestLog = join(directory, "requests.log");
  const replacementWatchStarted = join(directory, "replacement-watch-started.txt");
  await writeFile(databasePath, "stable database evidence");
  const executable = await executableWithSource(directory, `
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
const counterPath = ${JSON.stringify(counterPath)};
const run = existsSync(counterPath) ? Number(readFileSync(counterPath, "utf8")) + 1 : 1;
writeFileSync(counterPath, String(run));
${rpcLoop(`
    appendFileSync(${JSON.stringify(requestLog)}, JSON.stringify({ run, ...request }) + "\\n");
    let result;
    if (request.method === "initialize") result = {
      protocol_version: 1,
      version: "0.14.1",
      database: { path: ${JSON.stringify(databasePath)}, ready: true, features: { routing_metadata: true } },
      methods: ["initialize", "status", "chats.list", "messages.history", "messages.after", "messages.stats", "watch.subscribe", "watch.unsubscribe", "send"],
    };
    else if (request.method === "watch.subscribe") {
      if (run === 2) {
        writeFileSync(${JSON.stringify(replacementWatchStarted)}, "started");
        await Bun.sleep(300);
      }
      result = { subscription: run };
    } else result = { ok: true };
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");
    if (run === 1 && request.method === "watch.subscribe") {
      setTimeout(() => process.exit(0), 50);
    }
  `)}
  `);
  const messages = createProntoMessages({ imsgPath: executable });
  const subscription = await messages.subscribe({ onEvent: () => undefined });
  const markerDeadline = Date.now() + 5_000;
  let replacementStarted = false;
  while (!replacementStarted && Date.now() < markerDeadline) {
    replacementStarted = await readFile(replacementWatchStarted, "utf8")
      .then(() => true, () => false);
    if (!replacementStarted) await Bun.sleep(20);
  }
  expect(replacementStarted).toBe(true);

  await subscription.close();
  const requests = (await readFile(requestLog, "utf8")).trim().split("\n")
    .map((line) => JSON.parse(line));
  expect(requests).toContainEqual(expect.objectContaining({
    method: "watch.unsubscribe",
    params: { subscription: 2 },
    run: 2,
  }));
  await messages.close();
}, 10_000);
