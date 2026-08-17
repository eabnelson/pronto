import { describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import type { RuntimeAdapter, RuntimeInput } from "../../src/runtimes/types";
import { qualifyRuntime } from "../../src/runtimes/qualification";

class ProbeAdapter implements RuntimeAdapter {
  readonly executablePath = "/usr/local/bin/codex";
  readonly kind = "codex" as const;
  lastInput: RuntimeInput | null = null;
  constructor(readonly writesMarker = true) {}

  async run(input: RuntimeInput) {
    this.lastInput = input;
    const match = input.prompt.match(/create (.+) containing exactly: ([A-Za-z0-9_-]+)/);
    if (this.writesMarker && match !== null) await writeFile(match[1]!, match[2]!);
    return {
      output: { reply: "qualified" },
      status: "success" as const,
      toolActivity: "observed" as const,
    };
  }
}

const successfulRunner = async (_executable: string, args: readonly string[]) => ({
  exitCode: 0,
  stderr: "",
  stdout: args.includes("--help")
    ? "--dangerously-bypass-approvals-and-sandbox --ephemeral --json --output-schema"
    : "ok",
});

describe("runtime qualification", () => {
  test("proves authentication, required CLI capabilities, and effective permissions", async () => {
    const adapter = new ProbeAdapter();
    const result = await qualifyRuntime({
      adapter,
      bridgeExecutablePath: "/Applications/s4imsg/bin/s4imsg",
      commandRunner: successfulRunner,
      workingDirectory: "/Users/example/project",
    });
    expect(result.qualified).toBeTrue();
    expect(result.checks.map((check) => check.id)).toEqual([
      "codex-version",
      "codex-authentication",
      "codex-noninteractive-interface",
      "codex-effective-permissions",
    ]);
    expect(adapter.lastInput?.workingDirectory).toBe("/Users/example/project");
  });

  test("fails before the live probe when authentication is unavailable", async () => {
    let calls = 0;
    const result = await qualifyRuntime({
      adapter: new ProbeAdapter(),
      bridgeExecutablePath: "/Applications/s4imsg/bin/s4imsg",
      commandRunner: async (_executable, args) => {
        calls += 1;
        return {
          exitCode: args.includes("status") ? 1 : 0,
          stderr: "",
          stdout: "--dangerously-bypass-approvals-and-sandbox --ephemeral --json --output-schema",
        };
      },
      workingDirectory: "/Users/example/project",
    });
    expect(result.qualified).toBeFalse();
    expect(result.checks).toContainEqual(expect.objectContaining({
      id: "codex-authentication",
      status: "failed",
    }));
    expect(calls).toBe(3);
  });

  test("fails before the live probe when unrestricted mode is unavailable", async () => {
    const adapter = new ProbeAdapter();
    const result = await qualifyRuntime({
      adapter,
      bridgeExecutablePath: "/Applications/s4imsg/bin/s4imsg",
      commandRunner: async () => ({
        exitCode: 0,
        stderr: "",
        stdout: "--ephemeral --json --output-schema",
      }),
      workingDirectory: "/Users/example/project",
    });
    expect(result.qualified).toBeFalse();
    expect(adapter.lastInput).toBeNull();
  });

  test("rejects a runtime whose effective permissions cannot create the marker", async () => {
    const result = await qualifyRuntime({
      adapter: new ProbeAdapter(false),
      bridgeExecutablePath: "/Applications/s4imsg/bin/s4imsg",
      commandRunner: successfulRunner,
      workingDirectory: "/Users/example/project",
    });
    expect(result.qualified).toBeFalse();
    expect(result.checks.at(-1)).toMatchObject({
      id: "codex-effective-permissions",
      status: "failed",
    });
  });
});
