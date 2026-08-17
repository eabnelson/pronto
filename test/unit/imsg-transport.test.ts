import { describe, expect, test } from "bun:test";
import {
  ImsgRpcError,
  type ImsgRpc,
} from "../../src/imessage/rpc-client";
import { ImsgTransport, OutboundEchoTracker } from "../../src/imessage/transport";

class FakeRpc implements ImsgRpc {
  calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  handlers = new Map<string, Set<(params: unknown) => void | Promise<void>>>();
  result: unknown = { guid: "OUT-1", ok: true };
  stats: unknown = {
    chats: [{ chat_id: 42, service: "iMessage" }],
    sent_messages: 1,
  };

  async call(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    this.calls.push({ method, params });
    if (method === "messages.stats") {
      if (this.stats instanceof Error) throw this.stats;
      return this.stats;
    }
    if (method === "watch.subscribe") return { subscription: 7 };
    if (method === "watch.unsubscribe") return { ok: true };
    if (this.result instanceof Error) throw this.result;
    return this.result;
  }

  on(method: string, handler: (params: unknown) => void | Promise<void>): () => void {
    const handlers = this.handlers.get(method) ?? new Set();
    handlers.add(handler);
    this.handlers.set(method, handlers);
    return () => handlers.delete(handler);
  }

  async emit(method: string, params: unknown): Promise<void> {
    for (const handler of this.handlers.get(method) ?? []) await handler(params);
  }
}

describe("activation routing", () => {
  const messageWithoutService = {
    chat_id: 42,
    guid: "IN-1",
    id: 11,
    text: "@helper continue",
  };

  test("uses the matching chat service when an imsg message omits its service", async () => {
    const rpc = new FakeRpc();

    expect(await new ImsgTransport(rpc).activationFor(messageWithoutService, "@helper")).toMatchObject({
      chatId: 42,
      providerGuid: "IN-1",
      request: "continue",
    });
    expect(rpc.calls.map((call) => call.method)).toEqual(["messages.stats"]);
  });

  test("still rejects owner-absent, missing, or non-iMessage chat routing", async () => {
    for (const stats of [
      { chats: [{ chat_id: 42, service: "iMessage" }], sent_messages: 0 },
      { chats: [{ chat_id: 42, service: "SMS" }], sent_messages: 1 },
      { chats: [{ chat_id: 42 }], sent_messages: 1 },
      { chats: [{ chat_id: 99, service: "iMessage" }], sent_messages: 1 },
    ]) {
      const rpc = new FakeRpc();
      rpc.stats = stats;

      expect(await new ImsgTransport(rpc).activationFor(messageWithoutService, "@helper")).toBeNull();
      expect(rpc.calls.map((call) => call.method)).toEqual(["messages.stats"]);
    }
  });

  test("surfaces routing lookup failures instead of treating them as ineligible", async () => {
    const rpc = new FakeRpc();
    rpc.stats = new Error("stats unavailable");

    await expect(
      new ImsgTransport(rpc).activationFor(messageWithoutService, "@helper"),
    ).rejects.toThrow("stats unavailable");
  });

  test("admits one side of a configured self-chat mirror without filtering remote participants", async () => {
    const rpc = new FakeRpc();
    rpc.stats = {
      chats: [{ chat_id: 42, identifier: "+14145551212", service: "iMessage" }],
      sent_messages: 1,
    };
    const transport = new ImsgTransport(rpc, { selfChatHandle: "+14145551212" });

    expect(
      await transport.activationFor(
        { ...messageWithoutService, guid: "SELF-OUT", is_from_me: true },
        "@helper",
      ),
    ).toMatchObject({ providerGuid: "SELF-OUT", request: "continue" });
    expect(
      await transport.activationFor(
        { ...messageWithoutService, guid: "SELF-MIRROR", is_from_me: false },
        "@helper",
      ),
    ).toBeNull();

    rpc.stats = {
      chats: [{ chat_id: 42, identifier: "+14145550000", service: "iMessage" }],
      sent_messages: 1,
    };
    expect(
      await transport.activationFor(
        { ...messageWithoutService, guid: "REMOTE-IN", is_from_me: false },
        "@helper",
      ),
    ).toMatchObject({ providerGuid: "REMOTE-IN", request: "continue" });
  });
});

describe("text delivery", () => {
  test("targets the originating chat and confirms only a GUID-bearing result", async () => {
    const rpc = new FakeRpc();
    const result = await new ImsgTransport(rpc).sendText(42, "hello");
    expect(rpc.calls).toEqual([
      { method: "send", params: { chat_id: 42, text: "hello" } },
    ]);
    expect(result).toEqual({ disposition: "confirmed", guid: "OUT-1" });

    rpc.result = { ok: true };
    expect(await new ImsgTransport(rpc).sendText(42, "hello")).toEqual({
      disposition: "ambiguous",
    });
  });

  test("preserves imsg retry-safe and uncertain error dispositions", async () => {
    const rpc = new FakeRpc();
    rpc.result = new ImsgRpcError(-32001, "unknown", {
      disposition: "may_have_completed",
      retry_safe: false,
    });
    expect(await new ImsgTransport(rpc).sendText(42, "hello")).toEqual({
      disposition: "ambiguous",
    });

    rpc.result = new ImsgRpcError(-32603, "not started", {
      disposition: "not_started",
      retry_safe: true,
    });
    expect(await new ImsgTransport(rpc).sendText(42, "hello")).toEqual({
      disposition: "failed",
      retrySafe: true,
    });
  });
});

test("outbound echo fingerprints expire and remain bounded", () => {
  let now = 1_000;
  const tracker = new OutboundEchoTracker({ maxEntries: 2, now: () => now, ttlMs: 100 });
  tracker.record(1, "first");
  tracker.record(2, "second");
  tracker.record(3, "third");
  expect(tracker.matches(1, "first")).toBeFalse();
  expect(tracker.matches(3, "third")).toBeTrue();
  now += 101;
  expect(tracker.matches(3, "third")).toBeFalse();
});

test("watch filters activations and surfaces a resumable overflow cursor", async () => {
  const rpc = new FakeRpc();
  const activations: string[] = [];
  const rows: number[] = [];
  const overflows: number[] = [];
  const watch = await new ImsgTransport(rpc).watch({
    onActivation: (request) => {
      activations.push(request.request);
    },
    onOverflow: (cursor) => {
      overflows.push(cursor);
    },
    onMessageRowId: (rowId) => {
      rows.push(rowId);
    },
    sinceRowId: 10,
    tag: "@helper",
  });

  await rpc.emit("message", {
    message: {
      chat_id: 42,
      guid: "IN-UNTAGGED",
      id: 10,
      service: "iMessage",
      text: "ordinary conversation",
    },
    subscription: 7,
  });
  expect(rpc.calls.some((call) => call.method === "messages.stats")).toBeFalse();

  await rpc.emit("message", {
    message: {
      chat_id: 42,
      guid: "IN-1",
      id: 11,
      text: "@helper continue",
    },
    subscription: 7,
  });
  await rpc.emit("watch.overflow", {
    resume_after_rowid: 11,
    subscription: 7,
    terminal: true,
  });

  expect(activations).toEqual(["continue"]);
  expect(rows).toEqual([10, 11]);
  expect(overflows).toEqual([11]);
  await watch.close();
  expect(rpc.calls.at(-1)).toEqual({
    method: "watch.unsubscribe",
    params: { subscription: 7 },
  });
});
