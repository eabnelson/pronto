import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { ClaudeAdapter } from "../../src/runtimes/claude";
import { CodexAdapter } from "../../src/runtimes/codex";
import type {
  ProcessExecution,
  ProcessRunner,
  ProcessSpec,
} from "../../src/runtimes/process";
import { ProcessSpawnError } from "../../src/runtimes/process";

class FakeRunner implements ProcessRunner {
  executions: ProcessSpec[] = [];
  response: ProcessExecution = {
    exitCode: 0,
    outputLimitExceeded: false,
    stderr: "",
    stdout: "",
    timedOut: false,
  };
  observedMcpConfig: unknown = null;
  thrown: Error | null = null;

  async run(spec: ProcessSpec): Promise<ProcessExecution> {
    if (this.thrown !== null) throw this.thrown;
    this.executions.push(spec);
    const mcpIndex = spec.args.indexOf("--mcp-config");
    if (mcpIndex >= 0) {
      this.observedMcpConfig = JSON.parse(await readFile(spec.args[mcpIndex + 1]!, "utf8"));
    }
    return this.response;
  }
}

const input = {
  bridgeExecutablePath: "/Applications/s4imsg/bin/s4imsg",
  brokerUrl: "http://127.0.0.1:3456",
  capability: "secret-capability",
  prompt: "AUTHORIZED REQUEST\nDo the work",
  workingDirectory: "/Users/example/project",
};

describe("Codex adapter", () => {
  test("uses an ephemeral one-shot turn without overriding model or permissions", async () => {
    const runner = new FakeRunner();
    runner.response.stdout = [
      JSON.stringify({ type: "thread.started", thread_id: "fixture" }),
      JSON.stringify({
        item: { text: '{"reply":"done","summary":"bounded"}', type: "agent_message" },
        type: "item.completed",
      }),
    ].join("\n");

    expect(await new CodexAdapter("/usr/local/bin/codex", runner).run(input)).toEqual({
      output: { reply: "done", summary: "bounded" },
      status: "success",
      toolActivity: "none",
    });
    const execution = runner.executions[0]!;
    expect(execution.args).toContain("--ephemeral");
    expect(execution.args).toContain("--json");
    expect(execution.args).not.toContain("--model");
    expect(execution.args).not.toContain("--sandbox");
    expect(execution.args.join(" ")).not.toContain("bypass");
    expect(execution.args.join(" ")).not.toContain("secret-capability");
    expect(execution.env.S4IMSG_ATTEMPT_CAPABILITY).toBe("secret-capability");
    expect(execution.stdin).toBe(input.prompt);
  });
});

describe("Claude Code adapter", () => {
  test("loads one private MCP file while retaining user defaults", async () => {
    const runner = new FakeRunner();
    runner.response.stdout = [
      JSON.stringify({ subtype: "init", type: "system" }),
      JSON.stringify({
        structured_output: { reply: "done" },
        subtype: "success",
        type: "result",
      }),
    ].join("\n");

    expect(await new ClaudeAdapter("/usr/local/bin/claude", runner).run(input)).toEqual({
      output: { reply: "done" },
      status: "success",
      toolActivity: "none",
    });
    const execution = runner.executions[0]!;
    expect(execution.args).toContain("--no-session-persistence");
    expect(execution.args).toContain("--mcp-config");
    expect(execution.args).not.toContain("--model");
    expect(execution.args).not.toContain("--permission-mode");
    expect(execution.args.join(" ")).not.toContain("secret-capability");
    expect(runner.observedMcpConfig).toEqual({
      mcpServers: {
        s4imsg: {
          args: ["mcp"],
          command: input.bridgeExecutablePath,
          env: {
            S4IMSG_ATTEMPT_CAPABILITY: input.capability,
            S4IMSG_BROKER_URL: input.brokerUrl,
          },
        },
      },
    });
  });

  test("classifies malformed structured output as an application failure", async () => {
    const runner = new FakeRunner();
    runner.response.stdout = JSON.stringify({
      structured_output: { reply: "" },
      subtype: "success",
      type: "result",
    });
    expect(await new ClaudeAdapter("/usr/local/bin/claude", runner).run(input)).toMatchObject({
      status: "application-failure",
    });
  });
});

test("records observed tool activity from runtime event streams", async () => {
  const runner = new FakeRunner();
  runner.response.stdout = [
    JSON.stringify({
      item: { command: "touch file", type: "command_execution" },
      type: "item.completed",
    }),
    JSON.stringify({ item: { text: '{"reply":"done"}', type: "agent_message" }, type: "item.completed" }),
  ].join("\n");
  expect(await new CodexAdapter("/usr/local/bin/codex", runner).run(input)).toMatchObject({
    status: "success",
    toolActivity: "observed",
  });
});

test("classifies a spawn failure as replay-safe operational failure", async () => {
  const runner = new FakeRunner();
  runner.thrown = new ProcessSpawnError(new Error("ENOENT"));
  expect(await new CodexAdapter("/missing/codex", runner).run(input)).toEqual({
    reason: "spawn-failure",
    status: "operational-failure",
    toolActivity: "none",
  });
});

test("parks an unexpected runner failure as unknown side-effect state", async () => {
  const runner = new FakeRunner();
  runner.thrown = new Error("stream disconnected after launch");
  expect(await new CodexAdapter("/usr/local/bin/codex", runner).run(input)).toEqual({
    reason: "runner-failure",
    status: "operational-failure",
    toolActivity: "unknown",
  });
});

test("classifies permission denial as an application failure", async () => {
  const runner = new FakeRunner();
  runner.response = {
    exitCode: 1,
    outputLimitExceeded: false,
    stderr: "Tool permission denied by user policy",
    stdout: "",
    timedOut: false,
  };
  expect(await new ClaudeAdapter("/usr/local/bin/claude", runner).run(input)).toEqual({
    reason: "permission-denial",
    status: "application-failure",
    toolActivity: "none",
  });
});
