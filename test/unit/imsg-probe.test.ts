import { describe, expect, test } from "bun:test";
import { qualifyImsgStatus } from "../../src/imessage/probe";

const requiredMethods = [
  "initialize",
  "status",
  "chats.list",
  "messages.history",
  "messages.after",
  "messages.stats",
  "watch.subscribe",
  "watch.unsubscribe",
  "send",
];

test("qualifies the required RPC surface and reports optional degradation", () => {
  expect(
    qualifyImsgStatus({
      database: { features: { reactions: true }, ready: true },
      methods: requiredMethods,
      protocol_version: 1,
      version: "0.9.0",
    }),
  ).toEqual({
    degraded: ["polls", "reply-context", "routing-metadata"],
    version: "0.9.0",
  });
});

describe("fail-closed qualification", () => {
  test("rejects database denial, protocol drift, and missing methods", () => {
    expect(() =>
      qualifyImsgStatus({
        database: { ready: false },
        methods: requiredMethods,
        protocol_version: 1,
        version: "0.9.0",
      }),
    ).toThrow("Messages database");
    expect(() =>
      qualifyImsgStatus({
        database: { ready: true },
        methods: requiredMethods,
        protocol_version: 2,
        version: "0.9.0",
      }),
    ).toThrow("protocol");
    expect(() =>
      qualifyImsgStatus({
        database: { ready: true },
        methods: requiredMethods.filter((method) => method !== "send"),
        protocol_version: 1,
        version: "0.9.0",
      }),
    ).toThrow("send");
  });
});
