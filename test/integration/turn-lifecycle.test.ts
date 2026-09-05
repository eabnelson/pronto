import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ActivatedRequest } from "../../packages/cli/src/activation";
import { FAILURE_NOTICE, TurnCoordinator, TurnProcessor } from "../../packages/cli/src/core/turn";
import type { SendDisposition } from "../../packages/cli/src/imessage/transport";
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

class FakeTransport {
  readonly sends: Array<{ chatId: number; text: string }> = [];
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
  async sendText(chatId: number, text: string): Promise<SendDisposition> {
    this.sends.push({ chatId, text });
    return this.disposition;
  }
}

const source: CurrentChatSource = {
  attachment: async () => null,
  details: async () => ({}),
  history: async () => ({ messages: [] }),
};

const activation: ActivatedRequest = {
  activationTag: "@helper",
  chatId: 42,
  conversation: {
    chatId: 42,
    expiresAt: "2099-01-01T00:00:00.000Z",
    provider: "apple-messages",
    token: "persisted-conversation-reference",
    version: 1,
  },
  isFromMe: false,
  providerGuid: "IN-1",
  request: "Draft the launch note.",
  rowId: 1,
};

async function harness(primary: RuntimeAdapter, fallback?: RuntimeAdapter) {
  const directory = await mkdtemp(join(tmpdir(), "pronto-turn-"));
  temporaryDirectories.push(directory);
  const database = openProntoDatabase(join(directory, "state.sqlite"));
  const journal = new DeliveryJournal(database);
  const memory = new MemoryStore(database);
  const workspaces = new WorkspaceStore(database);
  const transport = new FakeTransport();
  const broker = new ConversationBroker(source);
  const processor = new TurnProcessor({
    bridgeExecutablePath: "/Applications/pronto/bin/pronto",
    broker,
    brokerUrl: "http://127.0.0.1:1",
    journal,
    memory,
    runtimes: new RuntimeChain(primary, fallback),
    transport,
    defaultWorkingDirectory: directory,
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
        chatId: 99,
        conversation: { ...activation.conversation, chatId: 99 },
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
        chatId: 42,
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
        chatId: 42,
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
        chatId: 42,
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
