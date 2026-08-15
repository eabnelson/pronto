import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ActivatedRequest } from "../../src/activation";
import { FAILURE_NOTICE, TurnCoordinator, TurnProcessor } from "../../src/core/turn";
import type { SendDisposition } from "../../src/imessage/transport";
import { RuntimeChain } from "../../src/runtimes/chain";
import type {
  RuntimeAdapter,
  RuntimeAttemptResult,
  RuntimeInput,
} from "../../src/runtimes/types";
import { chatKeyForId } from "../../src/storage/chat-key";
import { openS4imsgDatabase } from "../../src/storage/database";
import { DeliveryJournal } from "../../src/storage/journal";
import { MemoryStore } from "../../src/storage/memory";
import { ConversationBroker, type CurrentChatSource } from "../../src/tools/broker";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

class FakeAdapter implements RuntimeAdapter {
  readonly executablePath = "/usr/local/bin/fake";
  readonly inputs: RuntimeInput[] = [];
  constructor(
    readonly kind: "codex" | "claude",
    readonly result: RuntimeAttemptResult,
  ) {}
  async run(input: RuntimeInput): Promise<RuntimeAttemptResult> {
    this.inputs.push(input);
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
        attachments: [{ transfer_name: "brief.pdf" }],
        chat_id: 42,
        guid: "RECENT-1",
        is_from_me: false,
        service: "iMessage",
        text: "The launch is Friday.",
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
  attachments: [],
  chatId: 42,
  isFromMe: false,
  providerGuid: "IN-1",
  request: "Draft the launch note.",
  rowId: 1,
};

async function harness(primary: RuntimeAdapter, fallback?: RuntimeAdapter) {
  const directory = await mkdtemp(join(tmpdir(), "s4imsg-turn-"));
  temporaryDirectories.push(directory);
  const database = openS4imsgDatabase(join(directory, "state.sqlite"));
  const journal = new DeliveryJournal(database);
  const memory = new MemoryStore(database);
  const transport = new FakeTransport();
  const broker = new ConversationBroker(source);
  const processor = new TurnProcessor({
    bridgeExecutablePath: "/Applications/s4imsg/bin/s4imsg",
    broker,
    brokerUrl: "http://127.0.0.1:1",
    journal,
    memory,
    runtimes: new RuntimeChain(primary, fallback),
    transport,
    workingDirectory: directory,
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
  };
}

describe("turn lifecycle", () => {
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

      expect(h.transport.sends).toEqual([{ chatId: 42, text: "Launch note ready." }]);
      expect(h.journal.state("IN-1")).toBe("delivered");
      expect(h.memory.get(chatKeyForId(42, h.salt))).toEqual({
        exchanges: [{ reply: "Launch note ready.", request: "Draft the launch note." }],
        summary: "Planning a Friday launch.",
      });
      expect(primary.inputs[0]!.prompt).toContain("The launch is Friday.");
      expect(primary.inputs[0]!.prompt).toContain("AUTHORIZED REQUEST");
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
    try {
      h.coordinator.admit(activation);
      await h.coordinator.idle();
      expect(primary.inputs[0]!.prompt).toBe(fallback.inputs[0]!.prompt);
      expect(primary.inputs[0]!.capability).not.toBe(fallback.inputs[0]!.capability);
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
      expect(h.transport.sends).toEqual([{ chatId: 42, text: FAILURE_NOTICE }]);
      expect(h.memory.get(chatKeyForId(42, h.salt)).exchanges).toEqual([]);
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
      expect(h.transport.sends.map((send) => send.text)).toEqual(["first reply", "second reply"]);
    } finally {
      h.close();
    }
  });
});
