import { describe, expect, test } from "bun:test";
import {
  ImsgRpcError,
  type ImsgRpc,
} from "../../src/imessage/rpc-client";
import { ImsgTransport, OutboundEchoTracker } from "../../src/imessage/transport";

class FakeRpc implements ImsgRpc {
  after: unknown = { has_more: false, messages: [], next_rowid: 0 };
  nearby: unknown | Error = { messages: [] };
  calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  handlers = new Map<string, Set<(params: unknown) => void | Promise<void>>>();
  history: unknown[] | Error = [];
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
    if (method === "messages.history") {
      if (this.history instanceof Error) throw this.history;
      return { messages: this.history };
    }
    if (method === "messages.after") {
      if (params.attachments === false) {
        if (this.nearby instanceof Error) throw this.nearby;
        return this.nearby;
      }
      return this.after;
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
    expect(rpc.calls.map((call) => call.method)).toEqual(["messages.stats", "messages.after"]);
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

  test("does not query history for an untagged reply-shaped event", async () => {
    const rpc = new FakeRpc();

    expect(
      await new ImsgTransport(rpc).activationFor(
        {
          ...messageWithoutService,
          guid: "UNTAGGED-REPLY",
          reply_to_guid: "OUT-1",
          reply_to_text: "continue",
          text: "continue",
        },
        "@helper",
      ),
    ).toBeNull();
    expect(
      rpc.calls.some(
        (call) => call.method === "messages.history" || call.method === "messages.after",
      ),
    ).toBeFalse();
  });

  test("does not query nearby messages before the owner-participation gate", async () => {
    const rpc = new FakeRpc();
    rpc.stats = {
      chats: [{ chat_id: 42, service: "iMessage" }],
      sent_messages: 0,
    };

    expect(
      await new ImsgTransport(rpc).activationFor(
        {
          ...messageWithoutService,
          is_from_me: false,
          reply_to_guid: "OUT-1",
          reply_to_text: "@helper continue",
          service: "iMessage",
        },
        "@helper",
      ),
    ).toBeNull();
    expect(rpc.calls.map((call) => call.method)).toEqual(["messages.stats"]);
  });

  test("correlates a self-chat mirror without filtering ordinary participant replies", async () => {
    const rpc = new FakeRpc();
    rpc.stats = {
      chats: [{ chat_id: 42, identifier: "+14145551212", service: "iMessage" }],
      sent_messages: 1,
    };
    const transport = new ImsgTransport(rpc);
    const text = "@helper continue";

    expect(
      await transport.activationFor(
        {
          ...messageWithoutService,
          created_at: "2026-08-18T20:02:35.763Z",
          guid: "SELF-OUT",
          is_from_me: true,
          text,
        },
        "@helper",
      ),
    ).toMatchObject({ providerGuid: "SELF-OUT", request: "continue" });
    expect(
      await transport.activationFor(
        {
          ...messageWithoutService,
          created_at: "2026-08-18T20:02:35.635Z",
          guid: "SELF-MIRROR",
          id: 12,
          is_from_me: false,
          reply_to_guid: "SELF-OUT",
          reply_to_text: text,
          text,
        },
        "@helper",
      ),
    ).toBeNull();
    expect(rpc.calls.some((call) => call.method === "messages.history")).toBeFalse();

    expect(
      await transport.activationFor(
        {
          ...messageWithoutService,
          created_at: "2026-08-18T20:02:35.900Z",
          guid: "REMOTE-IN",
          id: 13,
          is_from_me: false,
          reply_to_guid: "SELF-OUT",
          reply_to_text: text,
          text,
        },
        "@helper",
      ),
    ).toMatchObject({ providerGuid: "REMOTE-IN", request: "continue" });

    expect(
      await transport.activationFor(
        {
          ...messageWithoutService,
          guid: "REMOTE-IN-NO-DATE",
          id: 14,
          is_from_me: false,
          reply_to_guid: "SELF-OUT",
          reply_to_text: text,
          text,
        },
        "@helper",
      ),
    ).toMatchObject({ providerGuid: "REMOTE-IN-NO-DATE", request: "continue" });

    expect(
      await transport.activationFor(
        {
          ...messageWithoutService,
          created_at: "2026-08-18T20:02:35.635Z",
          guid: "SELF-MIRROR-NO-REPLY",
          id: 20,
          is_from_me: false,
          text,
        },
        "@helper",
      ),
    ).toBeNull();
  });

  test("caches an outbound agent echo so its inbound mirror cannot self-activate", async () => {
    const rpc = new FakeRpc();
    let echoAvailable = true;
    const transport = new ImsgTransport(rpc, {
      matchesOutboundEcho: () => {
        const matched = echoAvailable;
        echoAvailable = false;
        return matched;
      },
    });
    const text = "The configured tag is @helper.";

    expect(
      await transport.activationFor(
        {
          chat_id: 42,
          created_at: "2026-08-18T20:02:35.763Z",
          guid: "AGENT-OUT",
          id: 30,
          is_from_me: true,
          service: "iMessage",
          text,
        },
        "@helper",
      ),
    ).toBeNull();
    expect(
      await transport.activationFor(
        {
          chat_id: 42,
          created_at: "2026-08-18T20:02:35.635Z",
          guid: "AGENT-MIRROR",
          id: 31,
          is_from_me: false,
          service: "iMessage",
          text,
        },
        "@helper",
      ),
    ).toBeNull();
  });

  test("admits a metadata-free tagged message when nearby lookup is unavailable", async () => {
    const rpc = new FakeRpc();
    rpc.nearby = new Error("history unavailable");

    expect(
      await new ImsgTransport(rpc).activationFor(
        {
          ...messageWithoutService,
          created_at: "2026-08-18T20:02:35.635Z",
          is_from_me: false,
          service: "iMessage",
        },
        "@helper",
      ),
    ).toMatchObject({ providerGuid: "IN-1", request: "continue" });
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
  const selfText = "@helper ping";
  const selfOutgoing = {
    chat_id: 42,
    created_at: "2026-08-18T20:02:35.763Z",
    guid: "SELF-WATCH-OUT",
    id: 12,
    is_from_me: true,
    service: "iMessage",
    text: selfText,
  };
  await rpc.emit("message", { message: selfOutgoing, subscription: 7 });
  await rpc.emit("message", {
    message: {
      chat_id: 42,
      created_at: "2026-08-18T20:02:35.635Z",
      guid: "SELF-WATCH-MIRROR",
      id: 13,
      is_from_me: false,
      reply_to_guid: "SELF-WATCH-OUT",
      reply_to_text: selfText,
      service: "iMessage",
      text: selfText,
    },
    subscription: 7,
  });
  await rpc.emit("watch.overflow", {
    resume_after_rowid: 13,
    subscription: 7,
    terminal: true,
  });

  expect(activations).toEqual(["continue", "ping"]);
  expect(rows).toEqual([10, 11, 12, 13]);
  expect(overflows).toEqual([13]);
  await watch.close();
  expect(rpc.calls.at(-1)).toEqual({
    method: "watch.unsubscribe",
    params: { subscription: 7 },
  });
});

test("catch-up correlates a self-chat mirror even when the outgoing row predates the cursor", async () => {
  const rpc = new FakeRpc();
  const text = "@helper ping";
  rpc.nearby = {
    messages: [
      {
        chat_id: 42,
        created_at: "2026-08-18T20:02:35.763Z",
        guid: "SELF-CATCHUP-OUT",
        id: 12,
        is_from_me: true,
        text,
      },
    ],
  };
  rpc.after = {
    has_more: false,
    messages: [
      {
        chat_id: 42,
        created_at: "2026-08-18T20:02:35.635Z",
        guid: "SELF-CATCHUP-MIRROR",
        id: 13,
        is_from_me: false,
        reply_to_guid: "SELF-CATCHUP-OUT",
        reply_to_text: text,
        service: "iMessage",
        text,
      },
    ],
    next_rowid: 13,
  };
  const activations: string[] = [];

  expect(
    await new ImsgTransport(rpc).catchUp({
      onActivation: (request) => {
        activations.push(request.request);
      },
      sinceRowId: 12,
      tag: "@helper",
    }),
  ).toBe(13);
  expect(activations).toEqual([]);
  expect(rpc.calls).toContainEqual({
    method: "messages.after",
    params: {
      attachments: false,
      include_reactions: true,
      limit: 100,
      since_rowid: 0,
    },
  });
});

test("catch-up correlates a restart-boundary mirror without reply metadata", async () => {
  const rpc = new FakeRpc();
  const text = "@helper ping";
  rpc.nearby = {
    messages: [
      {
        chat_id: 42,
        created_at: "2026-08-18T20:02:35.763Z",
        guid: "SELF-NO-REPLY-OUT",
        id: 12,
        is_from_me: true,
        text,
      },
    ],
  };
  rpc.after = {
    has_more: false,
    messages: [
      {
        chat_id: 42,
        created_at: "2026-08-18T20:02:35.635Z",
        guid: "SELF-NO-REPLY-MIRROR",
        id: 13,
        is_from_me: false,
        service: "iMessage",
        text,
      },
    ],
    next_rowid: 13,
  };
  const activations: string[] = [];

  expect(
    await new ImsgTransport(rpc).catchUp({
      onActivation: (request) => {
        activations.push(request.request);
      },
      sinceRowId: 12,
      tag: "@helper",
    }),
  ).toBe(13);
  expect(activations).toEqual([]);
});

test("correlation lookup failure suppresses a mirror-shaped restart row without stalling cursors", async () => {
  const text = "@helper ping";
  const mirror = {
    chat_id: 42,
    created_at: "2026-08-18T20:02:35.635Z",
    guid: "UNCERTAIN-MIRROR",
    id: 13,
    is_from_me: false,
    reply_to_guid: "MISSING-OUT",
    reply_to_text: text,
    service: "iMessage",
    text,
  };
  const watchRpc = new FakeRpc();
  watchRpc.nearby = new Error("history unavailable");
  const watchActivations: string[] = [];
  const watchRows: number[] = [];
  const watch = await new ImsgTransport(watchRpc).watch({
    onActivation: (request) => {
      watchActivations.push(request.request);
    },
    onMessageRowId: (rowId) => {
      watchRows.push(rowId);
    },
    onOverflow: () => undefined,
    tag: "@helper",
  });

  await watchRpc.emit("message", { message: mirror, subscription: 7 });
  expect(watchActivations).toEqual([]);
  expect(watchRows).toEqual([13]);
  await watch.close();

  const catchUpRpc = new FakeRpc();
  catchUpRpc.nearby = new Error("history unavailable");
  catchUpRpc.after = {
    has_more: false,
    messages: [mirror],
    next_rowid: 13,
  };
  const catchUpActivations: string[] = [];
  const catchUpRows: number[] = [];
  expect(
    await new ImsgTransport(catchUpRpc).catchUp({
      onActivation: (request) => {
        catchUpActivations.push(request.request);
      },
      onMessageRowId: (rowId) => {
        catchUpRows.push(rowId);
      },
      sinceRowId: 12,
      tag: "@helper",
    }),
  ).toBe(13);
  expect(catchUpActivations).toEqual([]);
  expect(catchUpRows).toEqual([13]);
});
