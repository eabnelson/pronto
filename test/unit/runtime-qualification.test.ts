import { describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import type { RuntimeAdapter, RuntimeInput } from "../../src/runtimes/types";
import { qualifyRuntime } from "../../src/runtimes/qualification";

class ProbeAdapter implements RuntimeAdapter {
  readonly executablePath = "/usr/local/bin/codex";
  readonly kind = "codex" as const;
  constructor(readonly writesMarker = true) {}

  async run(input: RuntimeInput) {
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
  stdout: args.includes("--help") ? "--ephemeral --json --output-schema" : "ok",
});

describe("runtime qualification", () => {
  test("proves authentication, required CLI capabilities, and effective permissions", async () => {
    const result = await qualifyRuntime({
      adapter: new ProbeAdapter(),
      bridgeExecutablePath: "/Applications/s4imsg/bin/s4imsg",
      commandRunner: successfulRunner,
    });
    expect(result.qualified).toBeTrue();
    expect(result.checks.map((check) => check.id)).toEqual([
      "codex-version",
      "codex-authentication",
      "codex-noninteractive-interface",
      "codex-effective-permissions",
    ]);
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
          stdout: "--ephemeral --json --output-schema",
        };
      },
    });
    expect(result.qualified).toBeFalse();
    expect(result.checks).toContainEqual(expect.objectContaining({
      id: "codex-authentication",
      status: "failed",
    }));
    expect(calls).toBe(3);
  });

  test("rejects a runtime whose effective permissions cannot create the marker", async () => {
    const result = await qualifyRuntime({
      adapter: new ProbeAdapter(false),
      bridgeExecutablePath: "/Applications/s4imsg/bin/s4imsg",
      commandRunner: successfulRunner,
    });
    expect(result.qualified).toBeFalse();
    expect(result.checks.at(-1)).toMatchObject({
      id: "codex-effective-permissions",
      status: "failed",
    });
  });
});
