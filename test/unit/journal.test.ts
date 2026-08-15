import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openS4imsgDatabase } from "../../src/storage/database";
import { DeliveryJournal } from "../../src/storage/journal";
import { MemoryStore } from "../../src/storage/memory";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

async function stores() {
  const directory = await mkdtemp(join(tmpdir(), "s4imsg-journal-"));
  temporaryDirectories.push(directory);
  const database = openS4imsgDatabase(join(directory, "state.sqlite"));
  return {
    close: () => database.close(),
    journal: new DeliveryJournal(database),
    memory: new MemoryStore(database),
  };
}

test("admits a provider GUID once and bounds pending work per chat", async () => {
  const { close, journal } = await stores();
  try {
    expect(
      journal.admit({ chatId: 42, chatKey: "chat-a", providerGuid: "event-1", request: "one" }),
    ).toEqual({ status: "accepted" });
    expect(
      journal.admit({ chatId: 42, chatKey: "chat-a", providerGuid: "event-1", request: "one" }),
    ).toEqual({ status: "duplicate" });
    for (let index = 2; index <= 4; index++) {
      expect(
        journal.admit({
          chatId: 42,
          chatKey: "chat-a",
          providerGuid: `event-${index}`,
          request: `${index}`,
        }),
      ).toEqual({ status: "accepted" });
    }
    expect(
      journal.admit({ chatId: 42, chatKey: "chat-a", providerGuid: "event-5", request: "five" }),
    ).toEqual({ status: "rate-limited" });
    expect(
      journal.database
        .query("SELECT tagged_request FROM delivery_events WHERE provider_guid = ?")
        .get("event-5"),
    ).toEqual({ tagged_request: null });
    expect(journal.operationalStatus().rateLimited).toBe(1);
  } finally {
    close();
  }
});

test("promotes accepted output only after confirmed delivery", async () => {
  const { close, journal, memory } = await stores();
  try {
    journal.admit({ chatId: 42, chatKey: "chat-a", providerGuid: "event-1", request: "question" });
    const lease = journal.lease("event-1");
    expect(lease).not.toBeNull();
    journal.accept("event-1", lease!, { reply: "answer", summary: "older work" });
    expect(memory.get("chat-a").exchanges).toEqual([]);
    journal.beginSend("event-1", lease!);
    journal.confirmDelivery("event-1", lease!, "OUT-1");

    expect(memory.get("chat-a")).toEqual({
      exchanges: [{ reply: "answer", request: "question" }],
      summary: "older work",
    });
    expect(
      journal.database
        .query(
          `SELECT tagged_request, accepted_reply, proposed_summary
           FROM delivery_events WHERE provider_guid = ?`,
        )
        .get("event-1"),
    ).toEqual({ accepted_reply: null, proposed_summary: null, tagged_request: null });
  } finally {
    close();
  }
});

test("keeps failure notices out of memory and durably suppresses their echoes", async () => {
  const { close, journal, memory } = await stores();
  try {
    journal.admit({ chatId: 42, chatKey: "chat-a", providerGuid: "event-1", request: "question" });
    const lease = journal.lease("event-1")!;
    journal.accept("event-1", lease, { reply: "Unable to complete that request." }, {
      memoryEligible: false,
    });
    journal.beginSend("event-1", lease, 42, "Unable to complete that request.");
    journal.confirmDelivery("event-1", lease, "OUT-1");

    expect(memory.get("chat-a").exchanges).toEqual([]);
    expect(journal.matchesOutboundEcho(42, "Unable to complete that request.")).toBeTrue();
    expect(journal.matchesOutboundEcho(42, "Unable to complete that request.")).toBeFalse();
  } finally {
    close();
  }
});

test("advances the durable message cursor monotonically without storing messages", async () => {
  const { close, journal } = await stores();
  try {
    expect(journal.cursor()).toBeUndefined();
    journal.advanceCursor(20);
    journal.advanceCursor(19);
    expect(journal.cursor()).toBe(20);
  } finally {
    close();
  }
});

test("reports content-free operational status and optional opaque chat keys", async () => {
  const { close, journal } = await stores();
  try {
    journal.admit({ chatId: 42, chatKey: "c_opaque", providerGuid: "event-1", request: "secret" });
    expect(journal.operationalStatus(true)).toMatchObject({
      active: 1,
      ambiguous: 0,
      chats: ["c_opaque"],
      lastSettledAt: null,
      parked: 0,
      rateLimited: 0,
    });
    expect(JSON.stringify(journal.operationalStatus(true))).not.toContain("secret");
  } finally {
    close();
  }
});

test("records content-free daemon health", async () => {
  const { close, journal } = await stores();
  try {
    expect(journal.daemonHealth()).toBeNull();
    journal.recordDaemonHealth("ready");
    expect(journal.daemonHealth()).toMatchObject({ state: "ready" });
    journal.recordDaemonHealth("failed");
    expect(journal.daemonHealth()).toMatchObject({ state: "failed" });
    journal.recordDegradedCapabilities(["polls", "reactions", "polls", "not valid"]);
    expect(journal.degradedCapabilities()).toEqual(["polls", "reactions"]);
  } finally {
    close();
  }
});

describe("restart recovery", () => {
  test("parks an interrupted runtime attempt whose tool activity is unknown", async () => {
    const { close, journal } = await stores();
    try {
      journal.admit({
        chatId: 42,
        chatKey: "chat-a",
        providerGuid: "unknown-attempt",
        request: "question",
      });
      const lease = journal.lease("unknown-attempt")!;
      journal.beginRuntimeAttempt("unknown-attempt", lease);

      expect(journal.recoverInterrupted()).toEqual({ ambiguous: 0, parked: 1, resumed: 0 });
      expect(journal.state("unknown-attempt")).toBe("parked");
      expect(journal.recoverInterrupted()).toEqual({ ambiguous: 0, parked: 0, resumed: 0 });
      expect(journal.state("unknown-attempt")).toBe("parked");
    } finally {
      close();
    }
  });

  test("resumes a completed tool-free runtime attempt exactly once", async () => {
    const { close, journal } = await stores();
    try {
      journal.admit({
        chatId: 42,
        chatKey: "chat-a",
        providerGuid: "tool-free-attempt",
        request: "question",
      });
      const lease = journal.lease("tool-free-attempt")!;
      journal.beginRuntimeAttempt("tool-free-attempt", lease);
      journal.recordToolActivity("tool-free-attempt", lease, "none");

      expect(journal.recoverInterrupted()).toEqual({ ambiguous: 0, parked: 0, resumed: 1 });
      expect(journal.state("tool-free-attempt")).toBe("admitted");
      expect(journal.recoverInterrupted()).toEqual({ ambiguous: 0, parked: 0, resumed: 0 });
      expect(journal.state("tool-free-attempt")).toBe("admitted");
    } finally {
      close();
    }
  });

  test("replays only proven pre-tool work and parks uncertain state", async () => {
    const { close, journal } = await stores();
    try {
      for (const providerGuid of ["safe", "side-effect", "ready", "sending"]) {
        journal.admit({ chatId: 42, chatKey: "chat-a", providerGuid, request: providerGuid });
      }
      const safeLease = journal.lease("safe")!;
      journal.recordToolActivity("safe", safeLease, false);
      const sideEffectLease = journal.lease("side-effect")!;
      journal.recordToolActivity("side-effect", sideEffectLease, true);
      const readyLease = journal.lease("ready")!;
      journal.accept("ready", readyLease, { reply: "ready answer" });
      const sendingLease = journal.lease("sending")!;
      journal.accept("sending", sendingLease, { reply: "answer" });
      journal.beginSend("sending", sendingLease);

      expect(journal.recoverInterrupted()).toEqual({ ambiguous: 1, parked: 1, resumed: 2 });
      expect(journal.state("safe")).toBe("admitted");
      expect(journal.state("side-effect")).toBe("parked");
      expect(journal.state("ready")).toBe("ready_to_send");
      expect(journal.state("sending")).toBe("ambiguous");
    } finally {
      close();
    }
  });
});
