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

  async call(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    this.calls.push({ method, params });
    if (method === "messages.stats") return { sent_messages: 1 };
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
  const overflows: number[] = [];
  const watch = await new ImsgTransport(rpc).watch({
    onActivation: (request) => {
      activations.push(request.request);
    },
    onOverflow: (cursor) => {
      overflows.push(cursor);
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
      service: "iMessage",
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
  expect(overflows).toEqual([11]);
  await watch.close();
  expect(rpc.calls.at(-1)).toEqual({
    method: "watch.unsubscribe",
    params: { subscription: 7 },
  });
});
