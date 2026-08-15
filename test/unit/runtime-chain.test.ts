import { describe, expect, test } from "bun:test";
import { RuntimeChain } from "../../src/runtimes/chain";
import type {
  RuntimeAdapter,
  RuntimeAttemptResult,
  RuntimeInput,
} from "../../src/runtimes/types";

class FakeAdapter implements RuntimeAdapter {
  calls: RuntimeInput[] = [];
  readonly executablePath = "/usr/local/bin/fake";
  constructor(
    readonly kind: "codex" | "claude",
    readonly result: RuntimeAttemptResult,
  ) {}
  async run(input: RuntimeInput): Promise<RuntimeAttemptResult> {
    this.calls.push(input);
    return this.result;
  }
}

const input: RuntimeInput = {
  bridgeExecutablePath: "/tmp/s4imsg",
  brokerUrl: "http://127.0.0.1:1",
  capability: "opaque",
  prompt: "immutable prompt",
  workingDirectory: "/tmp",
};

describe("operational fallback", () => {
  test("runs fallback once with the same immutable context when replay is safe", async () => {
    const primary = new FakeAdapter("codex", {
      reason: "authentication",
      status: "operational-failure",
      toolActivity: "none",
    });
    const fallback = new FakeAdapter("claude", {
      output: { reply: "fallback" },
      status: "success",
      toolActivity: "none",
    });
    const result = await new RuntimeChain(primary, fallback).run(input);

    expect(result).toMatchObject({ output: { reply: "fallback" }, runtime: "claude" });
    expect(fallback.calls).toHaveLength(1);
    expect(fallback.calls[0]).toBe(primary.calls[0]);
    expect(Object.isFrozen(fallback.calls[0])).toBeTrue();
  });

  test("does not replay unknown side effects or application failures", async () => {
    for (const primaryResult of [
      { reason: "timeout", status: "operational-failure", toolActivity: "unknown" },
      { reason: "invalid-output", status: "application-failure", toolActivity: "none" },
    ] satisfies RuntimeAttemptResult[]) {
      const primary = new FakeAdapter("codex", primaryResult);
      const fallback = new FakeAdapter("claude", {
        output: { reply: "should not run" },
        status: "success",
        toolActivity: "none",
      });
      expect(await new RuntimeChain(primary, fallback).run(input)).toMatchObject({
        runtime: "codex",
        status: primaryResult.status,
      });
      expect(fallback.calls).toHaveLength(0);
    }
  });
});
