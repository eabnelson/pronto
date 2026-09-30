import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ChannelActivation,
  ChatAddress,
  OutboundAttachment,
  SendDisposition,
  TurnChannel,
} from "../../packages/cli/src/channels/types";
import { stageOutboundAttachment } from "../../packages/cli/src/core/outbound-attachment";
import { FAILURE_NOTICE, TurnCoordinator, TurnProcessor } from "../../packages/cli/src/core/turn";
import {
  formatImessageReplyText,
  imessageReplyBodyCharacterLimit,
} from "../../packages/cli/src/imessage/reply-format";
import { RuntimeChain } from "../../packages/cli/src/runtimes/chain";
import type {
  RuntimeAdapter,
  RuntimeAttemptResult,
  RuntimeInput,
} from "../../packages/cli/src/runtimes/types";
import { chatKeyForId } from "../../packages/cli/src/storage/chat-key";
import { openProntoDatabase } from "../../packages/cli/src/storage/database";
import { DeliveryJournal } from "../../packages/cli/src/storage/journal";
import { MemoryStore } from "../../packages/cli/src/storage/memory";
import { promoteWorkspace, WorkspaceStore } from "../../packages/cli/src/storage/workspaces";
import { ConversationBroker, type CurrentChatSource } from "../../packages/cli/src/tools/broker";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

class FakeAdapter implements RuntimeAdapter {
  readonly executablePath = "/usr/local/bin/fake";
  readonly inputs: RuntimeInput[] = [];
  onRun?: () => void;
  constructor(
    readonly kind: "codex" | "claude",
    public result: RuntimeAttemptResult,
  ) {}
  async run(input: RuntimeInput): Promise<RuntimeAttemptResult> {
    this.inputs.push(input);
    this.onRun?.();
    return this.result;
  }
}

class OrderedAdapter implements RuntimeAdapter {
  readonly executablePath = "/usr/local/bin/fake";
  readonly kind = "codex" as const;
  readonly requests: string[] = [];
  #active = 0;
  maxActive = 0;

  async run(input: RuntimeInput): Promise<RuntimeAttemptResult> {
    this.#active += 1;
    this.maxActive = Math.max(this.maxActive, this.#active);
    const request = input.prompt.includes("\nAUTHORIZED REQUEST\nfirst request\n")
      ? "first"
      : "second";
    this.requests.push(request);
    await new Promise((resolve) => setTimeout(resolve, 5));
    this.#active -= 1;
    return { output: { reply: `${request} reply` }, status: "success", toolActivity: "none" };
  }
}

class FakeTransport implements TurnChannel {
  readonly conversationLabel = "iMessage or RCS";
  readonly sends: Array<{ chatId: number; text: string }> = [];
  formatReply(activationTag: string, text: string): string {
    return formatImessageReplyText(activationTag, text);
  }
  replyBodyCharacterLimit(activationTag: string, maxCharacters: number): number {
    return imessageReplyBodyCharacterLimit(activationTag, maxCharacters);
  }
  disposition: SendDisposition = { disposition: "confirmed", guid: "OUT-1" };
  async recentMessages(): Promise<unknown[]> {
    return [
      {
        attachments: [{
          available: true,
          mimeType: "application/pdf",
          name: "brief.pdf",
          sizeBytes: 12,
        }],
        fromMe: false,
        kind: "message",
        messageGuid: "RECENT-1",
        occurredAt: "2026-09-01T12:00:00.000Z",
        reaction: null,
        sender: "+15555550100",
        service: "iMessage",
        text: "The launch is Friday.",
        urlPreview: false,
      },
    ];
  }
  async sendText(
    chat: ChatAddress,
    text: string,
    _conversation?: unknown,
    attachment?: OutboundAttachment,
  ): Promise<SendDisposition> {
    this.sends.push({ chatId: Number(chat.id), text });
    if (attachment !== undefined) {
      this.attachments.push({
        content: await readFile(attachment.filePath, "utf8"),
        filePath: attachment.filePath,
      });
    }
    return this.disposition;
  }
  readonly attachments: Array<{ content: string; filePath: string }> = [];
}

/** A channel that can send files and acknowledges tagged messages, like WhatsApp. */
class RichTransport extends FakeTransport {
  readonly maxAttachmentBytes = 64;
  readonly acknowledged: Array<{ chat: ChatAddress; conversation: unknown }> = [];
  acknowledgment: () => Promise<void> = async () => undefined;
  async acknowledge(chat: ChatAddress, conversation: unknown): Promise<void> {
    this.acknowledged.push({ chat, conversation });
    await this.acknowledgment();
  }
}

const source: CurrentChatSource = {
  attachment: async () => null,
  details: async () => ({}),
  history: async () => ({ messages: [] }),
};

const conversation = {
  chatId: 42,
  expiresAt: "2099-01-01T00:00:00.000Z",
  provider: "apple-messages",
  token: "persisted-conversation-reference",
  version: 1,
};

const activation: ChannelActivation = {
  activationTag: "@helper",
  chat: { channel: "imessage", id: "42" },
  conversation,
  isFromMe: false,
  providerGuid: "IN-1",
  request: "Draft the launch note.",
};

async function harness<Transport extends FakeTransport = FakeTransport>(
  primary: RuntimeAdapter,
  fallback?: RuntimeAdapter,
  options: { staging?: boolean; transport?: Transport } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "pronto-turn-"));
  temporaryDirectories.push(directory);
  const database = openProntoDatabase(join(directory, "state.sqlite"));
  const journal = new DeliveryJournal(database);
  const memory = new MemoryStore(database);
  const workspaces = new WorkspaceStore(database);
  const transport = options.transport ?? new FakeTransport() as Transport;
  const staging = join(directory, "support", "outbound");
  const broker = new ConversationBroker(source);
  const processor = new TurnProcessor({
    bridgeExecutablePath: "/Applications/pronto/bin/pronto",
    broker,
    brokerUrl: "http://127.0.0.1:1",
    journal,
    memory,
    runtimes: new RuntimeChain(primary, fallback),
    channels: new Map([["imessage", transport]]),
    defaultWorkingDirectory: directory,
    ...(options.staging === true ? { outboundStagingDirectory: staging } : {}),
    workspaces,
  });
  const salt = "private-installation-salt";
  const coordinator = new TurnCoordinator(processor, journal, salt);
  return {
    close: () => database.close(),
    coordinator,
    database,
    journal,
    memory,
    salt,
    staging,
    transport,
    workspaces,
    directory,
  };
}

describe("turn lifecycle", () => {
  test("quiescing drains the active turn but preserves unstarted work for restart", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const adapter: RuntimeAdapter = {
      kind: "codex", executablePath: "/usr/local/bin/fixture",
      run: async () => {
        entered.resolve();
        await release.promise;
        return { status: "success", toolActivity: "none", output: { reply: "first reply" } };
      },
    };
    const h = await harness(adapter);
    try {
      h.coordinator.admit({ ...activation, providerGuid: "DRAIN-1" });
      await entered.promise;
      h.coordinator.admit({ ...activation, providerGuid: "DRAIN-2" });
      h.coordinator.quiesce();
      expect(() => h.coordinator.admit({ ...activation, providerGuid: "DRAIN-3" }))
        .toThrow("turn_coordinator_quiesced");
      release.resolve();
      await h.coordinator.idle();
      expect(h.transport.sends).toHaveLength(1);
      expect(h.journal.nextRunnable()?.providerGuid).toBe("DRAIN-2");
    } finally {
      release.resolve();
      await h.coordinator.idle();
      h.close();
    }
  });

  test("switches only on explicit intent and makes the folder durable after delivery", async () => {
    const primary = new FakeAdapter("codex", {
      output: { reply: "Working there." },
      status: "success",
      toolActivity: "none",
    });
    const h = await harness(primary);
    const project = join(h.directory, "Project With Spaces");
    await mkdir(project);
    const canonical = await realpath(project);
    try {
      h.coordinator.admit({
        ...activation,
        providerGuid: "IN-SWITCH",
        request: `work in "${project}" and inspect it`,
      });
      await h.coordinator.idle();
      expect(primary.inputs[0]!.workingDirectory).toBe(canonical);
      expect(h.workspaces.get(chatKeyForId(42, h.salt)).activeDirectory).toBe(canonical);

      primary.result = {
        output: { reply: "Mention handled." },
        status: "success",
        toolActivity: "none",
      };
      h.coordinator.admit({
        ...activation,
        providerGuid: "IN-MENTION",
        request: `summarize files in ${h.directory}`,
      });
      await h.coordinator.idle();
      expect(primary.inputs[1]!.workingDirectory).toBe(canonical);
    } finally {
      h.close();
    }
  });

  test("keeps an explicit switch temporary when delivery is ambiguous", async () => {
    const primary = new FakeAdapter("codex", {
      output: { reply: "Working there." },
      status: "success",
      toolActivity: "none",
    });
    const h = await harness(primary);
    const project = join(h.directory, "project-a");
    await mkdir(project);
    h.transport.disposition = { disposition: "ambiguous" };
    try {
      h.coordinator.admit({
        ...activation,
        providerGuid: "IN-AMBIGUOUS-SWITCH",
        request: `switch to ${project}`,
      });
      await h.coordinator.idle();
      expect(primary.inputs[0]!.workingDirectory).toBe(await realpath(project));
      expect(h.workspaces.get(chatKeyForId(42, h.salt)).activeDirectory).toBeNull();
    } finally {
      h.close();
    }
  });

  test("rejects negated, relative, and multi-path switch requests", async () => {
    const primary = new FakeAdapter("codex", {
      output: { reply: "No switch." },
      status: "success",
      toolActivity: "none",
    });
    const h = await harness(primary);
    const first = join(h.directory, "first-project");
    const second = join(h.directory, "second-project");
    await mkdir(first);
    await mkdir(second);
    try {
      for (const [index, request] of [
        `don't use ${first}`,
        'use "first-project"',
        `use ${first} and compare ${second}`,
      ].entries()) {
        h.coordinator.admit({
          ...activation,
          providerGuid: `IN-NO-SWITCH-${index}`,
          request,
        });
        await h.coordinator.idle();
        expect(primary.inputs[index]!.workingDirectory).toBe(await realpath(h.directory));
      }
      expect(h.workspaces.get(chatKeyForId(42, h.salt)).activeDirectory).toBeNull();
    } finally {
      h.close();
    }
  });

  test("publishes numbered discovery candidates and switches on the next confirmation", async () => {
    const h = await harness(
      new FakeAdapter("codex", {
        output: { reply: "I found these projects.", workspaceCandidates: [] },
        status: "success",
        toolActivity: "none",
      }),
    );
    const primary = h.coordinator.processor.dependencies.runtimes.primary as FakeAdapter;
    const first = join(h.directory, "first");
    const second = join(h.directory, "second");
    await mkdir(first);
    await mkdir(second);
    primary.result = {
      output: { reply: "I found these projects.", workspaceCandidates: [first, second] },
      status: "success",
      toolActivity: "none",
    };
    try {
      h.coordinator.admit({ ...activation, providerGuid: "IN-DISCOVER", request: "find my app" });
      await h.coordinator.idle();
      expect(h.transport.sends[0]!.text).toContain(`2. ${await realpath(second)}`);
      expect(h.workspaces.get(chatKeyForId(42, h.salt)).activeDirectory).toBeNull();

      primary.result = {
        output: { reply: "Switched." },
        status: "success",
        toolActivity: "none",
      };
      h.coordinator.admit({ ...activation, providerGuid: "IN-CONFIRM", request: "2" });
      await h.coordinator.idle();
      expect(primary.inputs[1]!.workingDirectory).toBe(await realpath(second));
      expect(h.workspaces.get(chatKeyForId(42, h.salt)).activeDirectory).toBe(
        await realpath(second),
      );
      expect(h.workspaces.get(chatKeyForId(42, h.salt)).pendingCandidates).toEqual([]);
    } finally {
      h.close();
    }
  });

  test("does not promote undelivered candidates or expose them to another chat", async () => {
    const primary = new FakeAdapter("codex", {
      output: { reply: "Choose this project." },
      status: "success",
      toolActivity: "none",
    });
    const h = await harness(primary);
    const candidate = join(h.directory, "candidate");
    await mkdir(candidate);
    primary.result = {
      output: { reply: "Choose this project.", workspaceCandidates: [candidate] },
      status: "success",
      toolActivity: "none",
    };
    h.transport.disposition = { disposition: "ambiguous" };
    try {
      h.coordinator.admit({ ...activation, providerGuid: "IN-AMBIGUOUS-DISCOVERY" });
      await h.coordinator.idle();
      expect(h.workspaces.get(chatKeyForId(42, h.salt)).pendingCandidates).toEqual([]);

      h.transport.disposition = { disposition: "confirmed", guid: "OUT-OTHER" };
      promoteWorkspace(h.database, {
        candidates: [await realpath(candidate)],
        chatKey: chatKeyForId(42, h.salt),
      });
      primary.result = {
        output: { reply: "Other chat stayed put." },
        status: "success",
        toolActivity: "none",
      };
      h.coordinator.admit({
        ...activation,
        chat: { channel: "imessage", id: "99" },
        conversation: { ...conversation, chatId: 99 },
        providerGuid: "IN-OTHER-CHAT",
        request: "1",
      });
      await h.coordinator.idle();
      expect(primary.inputs[1]!.workingDirectory).toBe(await realpath(h.directory));
      expect(h.workspaces.get(chatKeyForId(42, h.salt)).pendingCandidates).toEqual([
        await realpath(candidate),
      ]);
    } finally {
      h.close();
    }
  });

  test("persists only displayed candidates and bounds the composed reply", async () => {
    const primary = new FakeAdapter("codex", {
      output: { reply: "x".repeat(4_000) },
      status: "success",
      toolActivity: "none",
    });
    const h = await harness(primary);
    const valid = join(h.directory, "valid-project");
    await mkdir(valid);
    try {
      primary.result = {
        output: {
          reply: "x".repeat(4_000),
          workspaceCandidates: [join(h.directory, "missing"), valid],
        },
        status: "success",
        toolActivity: "none",
      };
      h.coordinator.admit({ ...activation, providerGuid: "IN-BOUNDED", request: "find it" });
      await h.coordinator.idle();

      expect(h.transport.sends[0]!.text.length).toBeLessThanOrEqual(4_000);
      expect(h.transport.sends[0]!.text).toContain(`1. ${await realpath(valid)}`);
      expect(h.transport.sends[0]!.text).not.toContain("missing");
      expect(h.workspaces.get(chatKeyForId(42, h.salt)).pendingCandidates).toEqual([
        await realpath(valid),
      ]);

      primary.result = {
        output: {
          reply: "No valid projects.",
          workspaceCandidates: [join(h.directory, "still-missing")],
        },
        status: "success",
        toolActivity: "none",
      };
      h.coordinator.admit({
        ...activation,
        providerGuid: "IN-INVALID-CANDIDATES",
        request: "find it again",
      });
      await h.coordinator.idle();
      expect(h.transport.sends[1]!.text).toBe("Helper\nNo valid projects.");
      expect(h.workspaces.get(chatKeyForId(42, h.salt)).pendingCandidates).toEqual([]);
    } finally {
      h.close();
    }
  });

  test("promotes an explicit switch and displayed discovery candidates together", async () => {
    const primary = new FakeAdapter("codex", {
      output: { reply: "Switched and found another." },
      status: "success",
      toolActivity: "none",
    });
    const h = await harness(primary);
    const active = join(h.directory, "active");
    const candidate = join(h.directory, "candidate");
    await mkdir(active);
    await mkdir(candidate);
    primary.result = {
      output: { reply: "Switched and found another.", workspaceCandidates: [candidate] },
      status: "success",
      toolActivity: "none",
    };
    try {
      h.coordinator.admit({
        ...activation,
        providerGuid: "IN-SWITCH-DISCOVER",
        request: `use ${active} and find my other project`,
      });
      await h.coordinator.idle();
      expect(h.workspaces.get(chatKeyForId(42, h.salt))).toEqual({
        activeDirectory: await realpath(active),
        pendingCandidates: [await realpath(candidate)],
      });
    } finally {
      h.close();
    }
  });

  test("keeps pending confirmation replayable across a tool-free restart", async () => {
    const primary = new FakeAdapter("codex", {
      output: { reply: "Switched after restart." },
      status: "success",
      toolActivity: "none",
    });
    const h = await harness(primary);
    const candidate = join(h.directory, "candidate");
    await mkdir(candidate);
    const chatKey = chatKeyForId(42, h.salt);
    promoteWorkspace(h.database, { candidates: [await realpath(candidate)], chatKey });
    try {
      h.journal.admit({
        chat: activation.chat,
        chatKey,
        providerGuid: "IN-PENDING-RESTART",
        request: "1",
      });
      const lease = h.journal.lease("IN-PENDING-RESTART")!;
      h.journal.beginRuntimeAttempt("IN-PENDING-RESTART", lease);
      h.journal.recordToolActivity("IN-PENDING-RESTART", lease, "none");

      expect(h.coordinator.start()).toEqual({ ambiguous: 0, parked: 0, resumed: 1 });
      await h.coordinator.idle();
      expect(primary.inputs[0]!.workingDirectory).toBe(await realpath(candidate));
      expect(h.workspaces.get(chatKey).activeDirectory).toBe(await realpath(candidate));
    } finally {
      h.close();
    }
  });

  test("names the exact unusable workspace and does not invoke a runtime", async () => {
    const primary = new FakeAdapter("codex", {
      output: { reply: "must not run" },
      status: "success",
      toolActivity: "none",
    });
    const h = await harness(primary);
    const active = join(h.directory, "active");
    const stale = join(h.directory, "deleted-candidate");
    await mkdir(active);
    const chatKey = chatKeyForId(42, h.salt);
    promoteWorkspace(h.database, { chatKey, workingDirectory: await realpath(active) });
    promoteWorkspace(h.database, { candidates: [stale], chatKey });
    try {
      h.coordinator.admit({ ...activation, providerGuid: "IN-STALE", request: "1" });
      await h.coordinator.idle();
      expect(primary.inputs).toHaveLength(0);
      expect(h.transport.sends[0]!.text).toContain(stale);
      expect(h.transport.sends[0]!.text).not.toContain(
        `couldn't use the folder ${await realpath(active)}`,
      );
      expect(h.workspaces.get(chatKey)).toEqual({
        activeDirectory: await realpath(active),
        pendingCandidates: [],
      });
    } finally {
      h.close();
    }
  });

  test("reports a missing stored active workspace with recovery guidance", async () => {
    const primary = new FakeAdapter("codex", {
      output: { reply: "must not run" },
      status: "success",
      toolActivity: "none",
    });
    const h = await harness(primary);
    const missing = join(h.directory, "deleted-active");
    const chatKey = chatKeyForId(42, h.salt);
    promoteWorkspace(h.database, { chatKey, workingDirectory: missing });
    try {
      h.coordinator.admit({ ...activation, providerGuid: "IN-MISSING-ACTIVE" });
      await h.coordinator.idle();
      expect(primary.inputs).toHaveLength(0);
      expect(h.transport.sends[0]!.text).toContain(missing);
      expect(h.transport.sends[0]!.text).toContain("use /path/to/project");
      expect(h.transport.sends[0]!.text).toContain("pronto forget");
    } finally {
      h.close();
    }
  });

  test("delivers one primary reply and promotes only confirmed output", async () => {
    const primary = new FakeAdapter("codex", {
      output: { reply: "Launch note ready.", summary: "Planning a Friday launch." },
      status: "success",
      toolActivity: "none",
    });
    const h = await harness(primary);
    try {
      expect(h.coordinator.admit(activation)).toBe("accepted");
      expect(h.coordinator.admit(activation)).toBe("duplicate");
      await h.coordinator.idle();

      expect(h.transport.sends).toEqual([{ chatId: 42, text: "Helper\nLaunch note ready." }]);
      expect(h.journal.state("IN-1")).toBe("delivered");
      expect(h.memory.get(chatKeyForId(42, h.salt))).toEqual({
        exchanges: [{ reply: "Launch note ready.", request: "Draft the launch note." }],
        summary: "Planning a Friday launch.",
      });
      expect(primary.inputs[0]!.prompt).toContain("The launch is Friday.");
      expect(primary.inputs[0]!.prompt).toContain("AUTHORIZED REQUEST");
      expect(primary.inputs[0]!.prompt).toContain("iMessage or RCS conversation");
    } finally {
      h.close();
    }
  });

  test("uses a fresh capability with byte-identical context for safe fallback", async () => {
    const primary = new FakeAdapter("codex", {
      reason: "offline",
      status: "operational-failure",
      toolActivity: "none",
    });
    const fallback = new FakeAdapter("claude", {
      output: { reply: "Fallback reply." },
      status: "success",
      toolActivity: "none",
    });
    const h = await harness(primary, fallback);
    const project = join(h.directory, "fallback-project");
    await mkdir(project);
    try {
      const fallbackToolActivity: { value: number | null } = { value: null };
      fallback.onRun = () => {
        const row = h.database
          .query("SELECT tool_activity FROM delivery_events WHERE provider_guid = ?")
          .get("IN-1") as { tool_activity: number | null };
        fallbackToolActivity.value = row.tool_activity;
      };
      h.coordinator.admit({ ...activation, request: `use ${project}` });
      await h.coordinator.idle();
      expect(primary.inputs[0]!.prompt).toBe(fallback.inputs[0]!.prompt);
      expect(primary.inputs[0]!.workingDirectory).toBe(await realpath(project));
      expect(fallback.inputs[0]!.workingDirectory).toBe(await realpath(project));
      expect(primary.inputs[0]!.capability).not.toBe(fallback.inputs[0]!.capability);
      expect(fallbackToolActivity.value).toBe(2);
      expect(h.transport.sends).toHaveLength(1);
      expect(
        h.database
          .query("SELECT runtime_kind, outcome FROM runtime_attempts ORDER BY id")
          .all(),
      ).toEqual([
        { outcome: "operational-failure", runtime_kind: "codex" },
        { outcome: "success", runtime_kind: "claude" },
      ]);
    } finally {
      h.close();
    }
  });

  test("parks unknown side effects silently without fallback", async () => {
    const primary = new FakeAdapter("codex", {
      reason: "timeout",
      status: "operational-failure",
      toolActivity: "unknown",
    });
    const fallback = new FakeAdapter("claude", {
      output: { reply: "must not run" },
      status: "success",
      toolActivity: "none",
    });
    const h = await harness(primary, fallback);
    try {
      h.coordinator.admit(activation);
      await h.coordinator.idle();
      expect(h.journal.state("IN-1")).toBe("parked");
      expect(fallback.inputs).toHaveLength(0);
      expect(h.transport.sends).toHaveLength(0);
    } finally {
      h.close();
    }
  });

  test("sends one content-free notice after definitive runtime failure", async () => {
    const primary = new FakeAdapter("codex", {
      reason: "permission-denial",
      status: "application-failure",
      toolActivity: "none",
    });
    const h = await harness(primary);
    try {
      h.coordinator.admit(activation);
      await h.coordinator.idle();
      expect(h.transport.sends).toEqual([{ chatId: 42, text: `Helper\n${FAILURE_NOTICE}` }]);
      expect(h.memory.get(chatKeyForId(42, h.salt)).exchanges).toEqual([]);
    } finally {
      h.close();
    }
  });

  test("sends a failure notice for invalid output even after read-only tool activity", async () => {
    const primary = new FakeAdapter("codex", {
      reason: "invalid-output",
      status: "application-failure",
      toolActivity: "observed",
    });
    const h = await harness(primary);
    try {
      h.coordinator.admit(activation);
      await h.coordinator.idle();
      expect(h.transport.sends).toEqual([{ chatId: 42, text: `Helper\n${FAILURE_NOTICE}` }]);
      expect(h.journal.state("IN-1")).toBe("delivered");
    } finally {
      h.close();
    }
  });

  test("parks an uncertain send and never promotes it", async () => {
    const primary = new FakeAdapter("codex", {
      output: { reply: "Possibly sent." },
      status: "success",
      toolActivity: "none",
    });
    const h = await harness(primary);
    h.transport.disposition = { disposition: "ambiguous" };
    try {
      h.coordinator.admit(activation);
      await h.coordinator.idle();
      expect(h.journal.state("IN-1")).toBe("ambiguous");
      expect(h.memory.get(chatKeyForId(42, h.salt)).exchanges).toEqual([]);
    } finally {
      h.close();
    }
  });

  test("processes admitted work through one global FIFO worker", async () => {
    const primary = new OrderedAdapter();
    const h = await harness(primary);
    try {
      h.coordinator.admit({ ...activation, providerGuid: "IN-1", request: "first request" });
      h.coordinator.admit({ ...activation, providerGuid: "IN-2", request: "second request" });
      await h.coordinator.idle();
      expect(primary.requests).toEqual(["first", "second"]);
      expect(primary.maxActive).toBe(1);
      expect(h.transport.sends.map((send) => send.text)).toEqual([
        "Helper\nfirst reply",
        "Helper\nsecond reply",
      ]);
    } finally {
      h.close();
    }
  });

  test("resumes an accepted reply after restart without rerunning the agent", async () => {
    const primary = new FakeAdapter("codex", {
      output: { reply: "must not run" },
      status: "success",
      toolActivity: "none",
    });
    const h = await harness(primary);
    try {
      h.journal.admit({
        activationTag: "@plan",
        chat: activation.chat,
        chatKey: chatKeyForId(42, h.salt),
        conversation: activation.conversation,
        providerGuid: "IN-RECOVER",
        request: "recover me",
      });
      const lease = h.journal.lease("IN-RECOVER")!;
      h.journal.accept("IN-RECOVER", lease, { reply: "already accepted" });

      expect(h.coordinator.start()).toEqual({ ambiguous: 0, parked: 0, resumed: 1 });
      await h.coordinator.idle();

      expect(primary.inputs).toHaveLength(0);
      expect(h.transport.sends).toEqual([{ chatId: 42, text: "Plan\nalready accepted" }]);
      expect(h.journal.state("IN-RECOVER")).toBe("delivered");
    } finally {
      h.close();
    }
  });

  test("fails a legacy accepted reply without marking an unattempted send ambiguous", async () => {
    const primary = new FakeAdapter("codex", {
      output: { reply: "must not run" },
      status: "success",
      toolActivity: "none",
    });
    const h = await harness(primary);
    try {
      h.journal.admit({
        activationTag: "@plan",
        chat: activation.chat,
        chatKey: chatKeyForId(42, h.salt),
        providerGuid: "IN-LEGACY-RECOVER",
        request: "recover me",
      });
      const lease = h.journal.lease("IN-LEGACY-RECOVER")!;
      h.journal.accept("IN-LEGACY-RECOVER", lease, { reply: "already accepted" });

      expect(h.coordinator.start()).toEqual({ ambiguous: 0, parked: 0, resumed: 1 });
      await h.coordinator.idle();

      expect(primary.inputs).toHaveLength(0);
      expect(h.transport.sends).toEqual([]);
      expect(h.journal.state("IN-LEGACY-RECOVER")).toBe("failed");
    } finally {
      h.close();
    }
  });
});

describe("reply attachments", () => {
  const replyWith = (attachmentPath: string) => new FakeAdapter("codex", {
    output: { attachmentPath, reply: "Chart attached." },
    status: "success",
    toolActivity: "observed",
  });
  const attachmentKeys = (database: { query(sql: string): { all(): unknown[] } }) => {
    return database.query("SELECT key FROM service_state WHERE key LIKE 'outbound_attachment:%'").all();
  };

  test("sends a private copy of the agent's file with the reply and deletes it once delivered", async () => {
    const primary = replyWith("");
    const h = await harness(primary, undefined, { staging: true, transport: new RichTransport() });
    const chart = join(h.directory, "chart.png");
    await writeFile(chart, "png bytes");
    primary.result = { output: { attachmentPath: chart, reply: "Chart attached." }, status: "success", toolActivity: "observed" };
    try {
      h.coordinator.start();
      h.coordinator.admit({ ...activation, providerGuid: "IN-FILE" });
      await h.coordinator.idle();

      expect(primary.inputs[0]!.prompt).toContain("return its absolute path in attachmentPath");
      expect(primary.inputs[0]!.prompt).toContain("at most 64 bytes");
      expect(h.transport.sends).toEqual([{ chatId: 42, text: "Helper\nChart attached." }]);
      expect(h.transport.attachments).toHaveLength(1);
      expect(h.transport.attachments[0]!.content).toBe("png bytes");
      expect(h.transport.attachments[0]!.filePath.startsWith(`${h.staging}/reply-`)).toBeTrue();
      expect(h.transport.attachments[0]!.filePath.endsWith("/chart.png")).toBeTrue();
      expect(await readdir(h.staging)).toEqual([]);
      expect(await readFile(chart, "utf8")).toBe("png bytes");
      expect(h.journal.state("IN-FILE")).toBe("delivered");
      expect(attachmentKeys(h.database)).toEqual([]);
    } finally {
      h.close();
    }
  });

  test("sends the text alone when the chosen file is unusable", async () => {
    const primary = replyWith("");
    const h = await harness(primary, undefined, { staging: true, transport: new RichTransport() });
    const large = join(h.directory, "large.bin");
    const real = join(h.directory, "real.txt");
    await writeFile(large, "x".repeat(65));
    await writeFile(real, "ok");
    await symlink(real, join(h.directory, "link.txt"));
    const candidates = ["real.txt", join(h.directory, "missing.txt"), join(h.directory, "link.txt"), large, h.directory];
    try {
      for (const [index, attachmentPath] of candidates.entries()) {
        primary.result = { output: { attachmentPath, reply: "Here." }, status: "success", toolActivity: "observed" };
        h.coordinator.admit({ ...activation, providerGuid: `IN-BAD-FILE-${index}` });
        await h.coordinator.idle();
        expect(h.journal.state(`IN-BAD-FILE-${index}`)).toBe("delivered");
      }
      expect(h.transport.sends).toHaveLength(candidates.length);
      expect(h.transport.attachments).toEqual([]);
      expect(await readdir(h.staging).catch(() => [])).toEqual([]);
    } finally {
      h.close();
    }
  });

  test("never retries an ambiguous file send and still deletes the staged copy", async () => {
    const primary = replyWith("");
    const h = await harness(primary, undefined, { staging: true, transport: new RichTransport() });
    const chart = join(h.directory, "chart.png");
    await writeFile(chart, "png bytes");
    primary.result = { output: { attachmentPath: chart, reply: "Chart." }, status: "success", toolActivity: "observed" };
    h.transport.disposition = { disposition: "ambiguous" };
    try {
      h.coordinator.admit({ ...activation, providerGuid: "IN-FILE-AMBIGUOUS" });
      await h.coordinator.idle();
      expect(h.journal.state("IN-FILE-AMBIGUOUS")).toBe("ambiguous");
      expect(h.transport.attachments).toHaveLength(1);
      expect(await readdir(h.staging)).toEqual([]);
      expect(attachmentKeys(h.database)).toEqual([]);
      h.coordinator.start();
      await h.coordinator.idle();
      expect(h.transport.sends).toHaveLength(1);
    } finally {
      h.close();
    }
  });

  test("resends a staged file accepted before a restart and sweeps orphaned copies", async () => {
    const primary = new FakeAdapter("codex", { output: { reply: "must not run" }, status: "success", toolActivity: "none" });
    const h = await harness(primary, undefined, { staging: true, transport: new RichTransport() });
    const source = join(h.directory, "report.pdf");
    await writeFile(source, "pdf bytes");
    const staged = (await stageOutboundAttachment({ maxBytes: 64, sourcePath: source, stagingDirectory: h.staging }))!;
    const orphan = (await stageOutboundAttachment({ maxBytes: 64, sourcePath: source, stagingDirectory: h.staging }))!;
    try {
      h.journal.admit({
        activationTag: "@plan",
        chat: activation.chat,
        chatKey: chatKeyForId(42, h.salt),
        conversation: activation.conversation,
        providerGuid: "IN-FILE-RECOVER",
        request: "send the report",
      });
      const lease = h.journal.lease("IN-FILE-RECOVER")!;
      h.journal.accept("IN-FILE-RECOVER", lease, { attachmentPath: staged, reply: "Report attached." });

      expect(h.coordinator.start()).toEqual({ ambiguous: 0, parked: 0, resumed: 1 });
      await h.coordinator.idle();

      expect(primary.inputs).toHaveLength(0);
      expect(h.transport.attachments).toEqual([{ content: "pdf bytes", filePath: staged }]);
      expect(h.journal.state("IN-FILE-RECOVER")).toBe("delivered");
      expect(await readdir(h.staging)).toEqual([]);
      expect(orphan).not.toBe(staged);
    } finally {
      h.close();
    }
  });

  test("offers no file to the agent when the app or install cannot stage one", async () => {
    const primary = replyWith("");
    const h = await harness(primary, undefined, { transport: new RichTransport() });
    const chart = join(h.directory, "chart.png");
    await writeFile(chart, "png bytes");
    primary.result = { output: { attachmentPath: chart, reply: "Chart." }, status: "success", toolActivity: "observed" };
    try {
      h.coordinator.admit({ ...activation, providerGuid: "IN-NO-STAGING" });
      await h.coordinator.idle();
      expect(primary.inputs[0]!.prompt).not.toContain("attachmentPath");
      expect(h.transport.sends).toHaveLength(1);
      expect(h.transport.attachments).toEqual([]);
    } finally {
      h.close();
    }

    const plain = await harness(primary, undefined, { staging: true });
    try {
      plain.coordinator.admit({ ...activation, providerGuid: "IN-NO-FILES" });
      await plain.coordinator.idle();
      expect(primary.inputs[1]!.prompt).not.toContain("attachmentPath");
      expect(plain.transport.attachments).toEqual([]);
      expect(await readdir(plain.staging).catch(() => [])).toEqual([]);
    } finally {
      plain.close();
    }
  });
});

describe("turn acknowledgment", () => {
  test("acknowledges the tagged message once when the runtime starts", async () => {
    const primary = new FakeAdapter("codex", { output: { reply: "Done." }, status: "success", toolActivity: "none" });
    const transport = new RichTransport();
    const h = await harness(primary, undefined, { transport });
    let acknowledgedBeforeRun = false;
    primary.onRun = () => {
      acknowledgedBeforeRun = transport.acknowledged.length === 1;
    };
    try {
      h.coordinator.admit(activation);
      await h.coordinator.idle();
      expect(acknowledgedBeforeRun).toBeTrue();
      expect(transport.acknowledged).toEqual([{ chat: activation.chat, conversation }]);
      expect(transport.sends).toHaveLength(1);
    } finally {
      h.close();
    }
  });

  test("never blocks or fails a turn on a slow or failing acknowledgment", async () => {
    const primary = new FakeAdapter("codex", { output: { reply: "Done." }, status: "success", toolActivity: "none" });
    const transport = new RichTransport();
    const h = await harness(primary, undefined, { transport });
    try {
      transport.acknowledgment = () => new Promise<void>(() => undefined);
      h.coordinator.admit({ ...activation, providerGuid: "IN-SLOW-ACK" });
      await h.coordinator.idle();
      transport.acknowledgment = async () => {
        throw new Error("reaction failed");
      };
      h.coordinator.admit({ ...activation, providerGuid: "IN-FAILED-ACK" });
      await h.coordinator.idle();
      expect(h.journal.state("IN-SLOW-ACK")).toBe("delivered");
      expect(h.journal.state("IN-FAILED-ACK")).toBe("delivered");
      expect(transport.acknowledged).toHaveLength(2);
    } finally {
      h.close();
    }
  });

  test("does not acknowledge a request that never reaches the runtime", async () => {
    const primary = new FakeAdapter("codex", { output: { reply: "Done." }, status: "success", toolActivity: "none" });
    const transport = new RichTransport();
    const h = await harness(primary, undefined, { transport });
    promoteWorkspace(h.database, {
      chatKey: chatKeyForId(42, h.salt),
      now: Date.now(),
      workingDirectory: join(h.directory, "deleted-project"),
    });
    try {
      h.coordinator.admit({ ...activation, providerGuid: "IN-NO-FOLDER" });
      await h.coordinator.idle();
      expect(primary.inputs).toHaveLength(0);
      expect(transport.acknowledged).toEqual([]);
    } finally {
      h.close();
    }
  });
});
