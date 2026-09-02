import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createProntoMessages,
  type MessagesEvent,
  type ProntoMessages,
} from "../src/index";
import * as publicApi from "../src/index";
import type { MessagesScopeLimits } from "../src/types";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

async function fixtureDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pronto-scoped-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function scopedClient(input: {
  readonly attachmentsRoot?: string;
  readonly databasePath: string;
  readonly event: Record<string, unknown>;
  readonly forwardPages?: Readonly<Record<string, unknown>>;
  readonly recent?: readonly Record<string, unknown>[];
  readonly recentOmitsHasMore?: boolean;
  readonly referenceKey?: string;
  readonly rpcLogPath?: string;
  readonly rpcParamsLogPath?: string;
  readonly scopeLimits?: MessagesScopeLimits;
  readonly scratchRoot?: string;
}): Promise<ProntoMessages> {
  const directory = await fixtureDirectory();
  const executable = join(directory, "imsg-fixture");
  await writeFile(executable, `#!/usr/bin/env bun
const scenario = ${JSON.stringify(input)};
const decoder = new TextDecoder();
const { appendFileSync } = require("node:fs");
let buffer = "";
for await (const chunk of Bun.stdin.stream()) {
  buffer += decoder.decode(chunk, { stream: true });
  while (buffer.includes("\\n")) {
    const newline = buffer.indexOf("\\n");
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (line.trim() === "") continue;
    const request = JSON.parse(line);
    if (scenario.rpcLogPath) appendFileSync(scenario.rpcLogPath, request.method + "\\n");
    if (scenario.rpcParamsLogPath) appendFileSync(scenario.rpcParamsLogPath, JSON.stringify(request) + "\\n");
    let result;
    if (request.method === "initialize") result = {
      protocol_version: 1,
      version: "0.14.1",
      database: { path: scenario.databasePath, ready: true, features: { routing_metadata: true, reactions: true } },
      methods: ["initialize", "status", "chats.list", "messages.history", "messages.after", "messages.stats", "watch.subscribe", "watch.unsubscribe", "send"],
    };
    else if (request.method === "watch.subscribe") result = { subscription: 71 };
    else if (request.method === "messages.stats") result = {
      chats: [{ chat_id: 42, service: "iMessage" }],
      sent_messages: 1,
    };
    else if (request.method === "messages.history") result = scenario.recentOmitsHasMore
      ? { messages: scenario.recent ?? [] }
      : { has_more: false, messages: scenario.recent ?? [] };
    else if (request.method === "messages.after") {
      const key = String(request.params.since_rowid);
      result = scenario.forwardPages?.[key] ?? {
        has_more: false,
        messages: request.params.since_rowid === scenario.event.id - 1 ? [scenario.event] : [],
        next_rowid: request.params.since_rowid,
      };
    } else if (request.method === "send") result = { ok: true, guid: "sent-guid" };
    else result = { ok: true };
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");
    if (request.method === "watch.subscribe") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "message", params: { subscription: 71, message: scenario.event } }) + "\\n");
    }
  }
}
`, { mode: 0o700 });
  await chmod(executable, 0o700);
  return createProntoMessages({
    ...(input.attachmentsRoot === undefined ? {} : { attachmentsRoot: input.attachmentsRoot }),
    imsgPath: executable,
    ...(input.referenceKey === undefined ? {} : { referenceKey: input.referenceKey }),
    scopeLimits: {
      maxAttachmentBytes: 1_024 * 1_024,
      maxAttachmentCount: 8,
      maxHistoryBytes: 1_024 * 1_024,
      maxHistoryMessages: 20,
      maxHistoryRows: 20,
      maxHistoryRpcCalls: 8,
      ttlMs: 60_000,
      ...input.scopeLimits,
    },
    ...(input.scratchRoot === undefined ? {} : { scratchRoot: input.scratchRoot }),
  });
}

function tamper(token: string): string {
  const last = token.slice(-1);
  return `${token.slice(0, -1)}${last === "A" ? "B" : "A"}`;
}

async function nextEvent(messages: ProntoMessages): Promise<MessagesEvent> {
  let resolveEvent!: (event: MessagesEvent) => void;
  const eventPromise = new Promise<MessagesEvent>((resolve) => { resolveEvent = resolve; });
  const subscriptionPromise = messages.subscribe({ onEvent: resolveEvent });
  const [event, subscription] = await Promise.all([eventPromise, subscriptionPromise]);
  await subscription.close();
  return event;
}

const observedEvent = {
  attachments: [],
  chat_id: 42,
  created_at: "2026-09-01T12:00:00.000Z",
  guid: "observed-guid",
  id: 101,
  is_from_me: true,
  service: "iMessage",
  text: "observed",
};

const historyBudget = {
  maxBytes: 128 * 1024,
  maxMessages: 1,
  maxRows: 1,
  maxRpcCalls: 1,
} as const;

test("a keyed conversation reference survives a client restart", async () => {
  const directory = await fixtureDirectory();
  const databasePath = join(directory, "chat.db");
  const referenceKey = "0123456789abcdef0123456789abcdef";
  await writeFile(databasePath, "database evidence");
  const first = await scopedClient({ databasePath, event: observedEvent, referenceKey });
  const observed = await nextEvent(first);
  await first.close();

  const resumed = await scopedClient({ databasePath, event: observedEvent, referenceKey });
  await resumed.qualify();
  expect(await resumed.reply({ conversation: observed.conversation, text: "resume" }))
    .toEqual({ providerMessageId: "sent-guid", status: "confirmed" });
  await expect(resumed.history({
    budget: historyBudget,
    conversation: observed.conversation,
  })).rejects.toThrow("messages_conversation_reference_invalid");
  await resumed.close();

  const wrongKey = await scopedClient({
    databasePath,
    event: observedEvent,
    referenceKey: "fedcba9876543210fedcba9876543210",
  });
  await wrongKey.qualify();
  await expect(wrongKey.reply({ conversation: observed.conversation, text: "reject" }))
    .rejects.toThrow("messages_conversation_reference_invalid");
  await wrongKey.close();
});

test("sealed conversation history preserves reactions, previews, pagination, and scope", async () => {
  const directory = await fixtureDirectory();
  const databasePath = join(directory, "chat.db");
  const rpcLogPath = join(directory, "rpc.log");
  await writeFile(databasePath, "database evidence");
  await writeFile(rpcLogPath, "");
  const reaction = {
    attachments: [],
    chat_id: 42,
    created_at: "2026-09-01T11:00:00.000Z",
    guid: "reaction-guid",
    id: 1,
    is_from_me: false,
    is_reaction: true,
    is_reaction_add: true,
    reacted_to_guid: "target-guid",
    reaction_type: "heart",
    service: "iMessage",
    text: "",
  };
  const preview = {
    attachments: [],
    chat_id: 42,
    created_at: "2026-09-01T11:01:00.000Z",
    guid: "preview-guid",
    id: 2,
    is_from_me: true,
    service: "iMessage",
    text: "https://example.com",
    url_preview: { title: "Example" },
  };
  const messages = await scopedClient({
    databasePath,
    event: observedEvent,
    forwardPages: {
      "0": { has_more: true, messages: [reaction], next_rowid: 1 },
      "1": { has_more: false, messages: [preview], next_rowid: 2 },
    },
    recent: [preview],
    rpcLogPath,
  });
  const observed = await nextEvent(messages);
  await writeFile(rpcLogPath, "");
  const first = await messages.history({
    budget: historyBudget,
    conversation: observed.conversation,
    includeReactions: true,
    mode: "forward",
  });
  expect((await readFile(rpcLogPath, "utf8")).trim().split("\n")).toEqual(["messages.after"]);
  expect(first.messages[0]?.message).toMatchObject({
    kind: "reaction",
    reaction: { added: true, targetProviderMessageId: "target-guid", type: "heart" },
  });
  expect(first.hasMore).toBeTrue();
  expect(first.continuation).toEqual(expect.any(String));

  const second = await messages.history({
    budget: historyBudget,
    continuation: first.continuation!,
    conversation: observed.conversation,
  });
  expect(second.messages[0]?.message).toMatchObject({ urlPreview: true });
  expect(second.hasMore).toBeFalse();

  const tamperedContinuation = tamper(first.continuation!);
  await expect(messages.history({
    budget: historyBudget,
    continuation: tamperedContinuation,
    conversation: observed.conversation,
  })).rejects.toThrow("reference_invalid");
  await expect(messages.reply({
    conversation: { ...observed.conversation, chatId: 99 },
    text: "wrong scope",
  })).rejects.toThrow("reference_invalid");
  await messages.close();
});

test("recent history omits the unsupported imsg reaction parameter", async () => {
  const directory = await fixtureDirectory();
  const databasePath = join(directory, "chat.db");
  const rpcParamsLogPath = join(directory, "rpc-params.log");
  await writeFile(databasePath, "database evidence");
  await writeFile(rpcParamsLogPath, "");
  const reaction = {
    attachments: [],
    chat_id: 42,
    created_at: "2026-09-01T11:00:00.000Z",
    guid: "reaction-guid",
    id: 1,
    is_from_me: false,
    is_reaction: true,
    is_reaction_add: true,
    reacted_to_guid: "target-guid",
    reaction_type: "heart",
    service: "iMessage",
    text: "",
  };
  const messages = await scopedClient({
    databasePath,
    event: observedEvent,
    recent: [reaction],
    recentOmitsHasMore: true,
    rpcParamsLogPath,
  });
  const observed = await nextEvent(messages);
  await writeFile(rpcParamsLogPath, "");

  const page = await messages.history({
    budget: historyBudget,
    conversation: observed.conversation,
    includeReactions: true,
    mode: "recent",
  });

  const request = JSON.parse((await readFile(rpcParamsLogPath, "utf8")).trim());
  expect(request).toMatchObject({ method: "messages.history" });
  expect(request.params).not.toHaveProperty("include_reactions");
  expect(page.messages[0]?.message.kind).toBe("reaction");
  expect(page.hasMore).toBeFalse();
  await messages.close();
});

test("scope expiry and cumulative budgets fail closed", async () => {
  const directory = await fixtureDirectory();
  const databasePath = join(directory, "chat.db");
  const rpcLogPath = join(directory, "rpc.log");
  await writeFile(databasePath, "database evidence");
  const recent = [{
    ...observedEvent,
    guid: "recent-guid",
    id: 1,
  }];
  const budgeted = await scopedClient({
    databasePath,
    event: observedEvent,
    recent,
    scopeLimits: { maxHistoryMessages: 1 },
  });
  const budgetedEvent = await nextEvent(budgeted);
  await budgeted.history({ budget: historyBudget, conversation: budgetedEvent.conversation });
  await expect(budgeted.history({
    budget: historyBudget,
    conversation: budgetedEvent.conversation,
  })).rejects.toThrow("budget_exhausted");
  await budgeted.close();

  const expiring = await scopedClient({
    databasePath,
    event: observedEvent,
    recent,
    rpcLogPath,
    scopeLimits: { ttlMs: 500 },
  });
  const expiringEvent = await nextEvent(expiring);
  await Bun.sleep(550);
  await expect(expiring.history({
    budget: historyBudget,
    conversation: expiringEvent.conversation,
  })).rejects.toThrow("reference_invalid");
  expect(await expiring.reply({
    conversation: expiringEvent.conversation,
    text: "must remain unsent",
  })).toEqual({ retryable: false, status: "failed" });
  expect(await readFile(rpcLogPath, "utf8")).not.toContain("send\n");
  await expiring.close();
});

test("package root exposes only the scoped factory at runtime", () => {
  expect(Object.keys(publicApi).sort()).toEqual(["createProntoMessages"]);
});

test("conversation and continuation references fail closed after database replacement", async () => {
  const directory = await fixtureDirectory();
  const databasePath = join(directory, "chat.db");
  await writeFile(databasePath, "first database evidence");
  const messages = await scopedClient({ databasePath, event: observedEvent });
  const observed = await nextEvent(messages);
  const replacement = join(directory, "replacement.db");
  await writeFile(replacement, "second database evidence");
  await rename(replacement, databasePath);
  await expect(messages.history({
    budget: historyBudget,
    conversation: observed.conversation,
  })).rejects.toThrow("scope_changed");
  await messages.close();
});

test("attachment references enforce containment, symlinks, file evidence, size, and MIME", async () => {
  const directory = await fixtureDirectory();
  const attachmentsRoot = join(directory, "Attachments");
  const scratchRoot = join(directory, "scratch");
  await mkdir(attachmentsRoot, { mode: 0o700 });
  const goodPath = join(attachmentsRoot, "good.png");
  const replacePath = join(attachmentsRoot, "replace.png");
  const sizePath = join(attachmentsRoot, "size.png");
  const mimePath = join(attachmentsRoot, "mime.png");
  const outsidePath = join(directory, "outside.png");
  const linkPath = join(attachmentsRoot, "link.png");
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  await Promise.all([
    writeFile(goodPath, png),
    writeFile(replacePath, png),
    writeFile(sizePath, png),
    writeFile(mimePath, "plain text"),
    writeFile(outsidePath, png),
  ]);
  await symlink(outsidePath, linkPath);
  const attachment = (path: string, id: string, size: number) => ({
    attachment_id: id,
    mime_type: "image/png",
    original_path: path,
    total_bytes: size,
    transfer_name: `${id}.png`,
  });
  const event = {
    ...observedEvent,
    attachments: [
      attachment(goodPath, "good", png.length),
      attachment(outsidePath, "outside", png.length),
      attachment(linkPath, "link", png.length),
      attachment(replacePath, "replace", png.length),
      attachment(sizePath, "size", png.length),
      attachment(mimePath, "mime", Buffer.byteLength("plain text")),
    ],
  };
  const databasePath = join(directory, "chat.db");
  await writeFile(databasePath, "database evidence");
  const messages = await scopedClient({
    attachmentsRoot,
    databasePath,
    event,
    scratchRoot,
  });
  const observed = await nextEvent(messages);
  const attachments = observed.message.attachments;
  expect(attachments.map(({ available }) => available)).toEqual([
    true, false, false, true, true, true,
  ]);
  expect(JSON.stringify(observed)).not.toContain(attachmentsRoot);
  expect(JSON.stringify(observed)).not.toContain(goodPath);

  const good = await messages.materializeAttachment({
    attachment: attachments[0]!.reference!,
    conversation: observed.conversation,
    maxBytes: png.length,
  });
  expect(await readFile(good.path)).toEqual(png);
  expect(good.mimeType).toBe("image/png");
  await good.dispose();
  await expect(readFile(good.path)).rejects.toMatchObject({ code: "ENOENT" });

  const replacement = join(directory, "same-size-replacement.png");
  await writeFile(replacement, Buffer.from(png).fill(9, 8));
  await rename(replacement, replacePath);
  await expect(messages.materializeAttachment({
    attachment: attachments[3]!.reference!,
    conversation: observed.conversation,
    maxBytes: png.length,
  })).rejects.toThrow("file_changed");

  await writeFile(sizePath, Buffer.concat([png, Buffer.from([4])]));
  await expect(messages.materializeAttachment({
    attachment: attachments[4]!.reference!,
    conversation: observed.conversation,
    maxBytes: png.length + 1,
  })).rejects.toThrow("file_changed");

  await expect(messages.materializeAttachment({
    attachment: attachments[5]!.reference!,
    conversation: observed.conversation,
    maxBytes: 100,
  })).rejects.toThrow("mime_mismatch");

  const tampered = attachments[0]!.reference!;
  await expect(messages.materializeAttachment({
    attachment: { ...tampered, token: tamper(tampered.token) },
    conversation: observed.conversation,
    maxBytes: png.length,
  })).rejects.toThrow("reference_invalid");
  await messages.close();
});
