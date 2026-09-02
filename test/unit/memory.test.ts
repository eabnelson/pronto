import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openProntoDatabase } from "../../packages/cli/src/storage/database";
import { MemoryStore } from "../../packages/cli/src/storage/memory";
import { chatKeyForId } from "../../packages/cli/src/storage/chat-key";
import { DeliveryJournal } from "../../packages/cli/src/storage/journal";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

test("derives stable opaque chat keys from the private installation salt", () => {
  const key = chatKeyForId(42, "private-salt");
  expect(key).toBe(chatKeyForId(42, "private-salt"));
  expect(key).not.toBe(chatKeyForId(43, "private-salt"));
  expect(key).not.toContain("42");
});

test("retains eight exact exchanges, one valid summary, and supports forget", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pronto-memory-"));
  temporaryDirectories.push(directory);
  const database = openProntoDatabase(join(directory, "state.sqlite"));
  const memory = new MemoryStore(database);
  try {
    for (let index = 1; index <= 9; index++) {
      memory.promote({
        eventGuid: `event-${index}`,
        chatKey: "chat-a",
        reply: `reply-${index}`,
        request: `request-${index}`,
        ...(index === 9 ? { summary: "summary" } : {}),
      });
    }
    expect(memory.get("chat-a").exchanges).toHaveLength(8);
    expect(memory.get("chat-a").exchanges[0]).toEqual({
      reply: "reply-2",
      request: "request-2",
    });
    expect(memory.get("chat-a").summary).toBe("summary");

    memory.promote({
      chatKey: "chat-a",
      eventGuid: "event-10",
      reply: "reply-10",
      request: "request-10",
      summary: "x".repeat(4_001),
    });
    expect(memory.get("chat-a").summary).toBe("summary");

    const journal = new DeliveryJournal(database);
    journal.admit({ chatId: 42, chatKey: "chat-a", providerGuid: "pending", request: "private" });
    const lease = journal.lease("pending")!;
    journal.accept("pending", lease, { reply: "private reply" });
    journal.beginSend("pending", lease);
    journal.markAmbiguous("pending", lease);
    memory.forget("chat-a");
    expect(memory.get("chat-a")).toEqual({ exchanges: [], summary: null });
    expect(
      database
        .query(
          "SELECT tagged_request, accepted_reply, proposed_summary FROM delivery_events WHERE provider_guid = 'pending'",
        )
        .get(),
    ).toEqual({ accepted_reply: null, proposed_summary: null, tagged_request: null });
  } finally {
    database.close();
  }
});
