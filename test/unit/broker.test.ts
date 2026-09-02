import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ConversationBroker,
  type CurrentChatSource,
} from "../../packages/cli/src/tools/broker";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

class FakeSource implements CurrentChatSource {
  calls: Array<{ chatId: number; tool: string }> = [];
  attachmentPath: string | null = null;

  async details(chatId: number): Promise<unknown> {
    this.calls.push({ chatId, tool: "details" });
    return { participants: ["participant"], service: "iMessage" };
  }

  async history(chatId: number, limit: number): Promise<unknown> {
    this.calls.push({ chatId, tool: "history" });
    return { messages: [{ text: "x".repeat(limit * 20) }] };
  }

  async attachment(chatId: number, messageGuid: string, attachmentId: string) {
    this.calls.push({ chatId, tool: "attachment" });
    return this.attachmentPath === null
      ? null
      : { attachmentId, messageGuid, name: "notes.txt", path: this.attachmentPath };
  }
}

test("binds an opaque capability to exactly one chat", async () => {
  const source = new FakeSource();
  const broker = new ConversationBroker(source);
  const capability = broker.issue(42);

  expect(await broker.query(capability.token, "current_chat_details", {})).toMatchObject({
    service: "iMessage",
  });
  expect(source.calls).toEqual([{ chatId: 42, tool: "details" }]);
  await expect(
    broker.query(capability.token, "current_chat_history", { chat_id: 99 }),
  ).rejects.toThrow("Unknown argument");
  expect(capability).not.toHaveProperty("chatId");
});

describe("capability lifecycle", () => {
  test("fails closed after revocation or expiry", async () => {
    let now = 100;
    const broker = new ConversationBroker(new FakeSource(), { now: () => now, ttlMs: 10 });
    const revoked = broker.issue(1);
    broker.revoke(revoked.token);
    await expect(broker.query(revoked.token, "current_chat_details", {})).rejects.toThrow(
      "Invalid or expired",
    );

    const expired = broker.issue(2);
    now += 11;
    await expect(broker.query(expired.token, "current_chat_details", {})).rejects.toThrow(
      "Invalid or expired",
    );
  });

  test("enforces per-call and cumulative output budgets", async () => {
    const broker = new ConversationBroker(new FakeSource(), {
      maxCallCharacters: 100,
      maxTurnCharacters: 150,
    });
    const capability = broker.issue(1);
    const first = await broker.query(capability.token, "current_chat_history", { limit: 50 });
    expect(JSON.stringify(first).length).toBeLessThanOrEqual(100);
    await expect(
      broker.query(capability.token, "current_chat_history", { limit: 50 }),
    ).rejects.toThrow("budget");
  });
});

test("returns only a canonical path selected by the fixed-chat source", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pronto-attachment-"));
  temporaryDirectories.push(directory);
  const file = join(directory, "notes.txt");
  await writeFile(file, "private attachment contents");
  const source = new FakeSource();
  source.attachmentPath = file;
  const broker = new ConversationBroker(source);
  const capability = broker.issue(7);

  expect(
    await broker.query(capability.token, "current_chat_attachment", {
      attachment_id: "A1",
      message_guid: "M1",
    }),
  ).toEqual({ attachmentId: "A1", messageGuid: "M1", name: "notes.txt", path: await realpath(file) });
  await expect(
    broker.query(capability.token, "current_chat_attachment", {
      attachment_id: "A1",
      message_guid: "M1",
      path: "/etc/passwd",
    }),
  ).rejects.toThrow("Unknown argument");

  source.attachmentPath = "notes.txt";
  await expect(
    broker.query(capability.token, "current_chat_attachment", {
      attachment_id: "A1",
      message_guid: "M1",
    }),
  ).rejects.toThrow("must be absolute");
});
