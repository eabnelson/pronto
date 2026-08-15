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

describe("restart recovery", () => {
  test("replays only proven pre-tool work and parks uncertain state", async () => {
    const { close, journal } = await stores();
    try {
      for (const providerGuid of ["safe", "side-effect", "sending"]) {
        journal.admit({ chatId: 42, chatKey: "chat-a", providerGuid, request: providerGuid });
      }
      const safeLease = journal.lease("safe")!;
      journal.recordToolActivity("safe", safeLease, false);
      const sideEffectLease = journal.lease("side-effect")!;
      journal.recordToolActivity("side-effect", sideEffectLease, true);
      const sendingLease = journal.lease("sending")!;
      journal.accept("sending", sendingLease, { reply: "answer" });
      journal.beginSend("sending", sendingLease);

      expect(journal.recoverInterrupted()).toEqual({ ambiguous: 1, parked: 1, resumed: 1 });
      expect(journal.state("safe")).toBe("admitted");
      expect(journal.state("side-effect")).toBe("parked");
      expect(journal.state("sending")).toBe("ambiguous");
    } finally {
      close();
    }
  });
});
