import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeAdapter } from "../../src/runtimes/claude";
import { CodexAdapter } from "../../src/runtimes/codex";
import type {
  ProcessExecution,
  ProcessRunner,
  ProcessSpec,
} from "../../src/runtimes/process";
import { ProcessSpawnError } from "../../src/runtimes/process";

class FakeRunner implements ProcessRunner {
  codexHome: string | null = null;
  executions: ProcessSpec[] = [];
  response: ProcessExecution = {
    exitCode: 0,
    outputLimitExceeded: false,
    stderr: "",
    stdout: "",
    timedOut: false,
  };
  observedMcpConfig: unknown = null;
  observedCodexProfile: string | null = null;
  observedCodexProfileMode: number | null = null;
  thrown: Error | null = null;

  async run(spec: ProcessSpec): Promise<ProcessExecution> {
    if (this.thrown !== null) throw this.thrown;
    this.executions.push(spec);
    const mcpIndex = spec.args.indexOf("--mcp-config");
    if (mcpIndex >= 0) {
      this.observedMcpConfig = JSON.parse(await readFile(spec.args[mcpIndex + 1]!, "utf8"));
    }
    const profileIndex = spec.args.indexOf("--profile");
    if (profileIndex >= 0 && this.codexHome !== null) {
      const profilePath = join(this.codexHome, `${spec.args[profileIndex + 1]!}.config.toml`);
      this.observedCodexProfile = await readFile(profilePath, "utf8");
      this.observedCodexProfileMode = (await stat(profilePath)).mode & 0o777;
    }
    return this.response;
  }
}

const temporaryDirectories: string[] = [];

async function codexAdapter(runner: FakeRunner, executablePath = "/usr/local/bin/codex") {
  const codexHome = await mkdtemp(join(tmpdir(), "s4imsg-codex-home-"));
  temporaryDirectories.push(codexHome);
  runner.codexHome = codexHome;
  return { adapter: new CodexAdapter(executablePath, runner, codexHome), codexHome };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

const input = {
  bridgeExecutableArgs: ["/source/src/cli.ts"],
  bridgeExecutablePath: "/Applications/s4imsg/bin/s4imsg",
  brokerUrl: "http://127.0.0.1:3456",
  capability: "secret-capability",
  prompt: "AUTHORIZED REQUEST\nDo the work",
  workingDirectory: "/Users/example/project",
};

describe("Codex adapter", () => {
  test("uses an ephemeral one-shot turn with unrestricted no-prompt permissions", async () => {
    const runner = new FakeRunner();
    const { adapter, codexHome } = await codexAdapter(runner);
    runner.response.stdout = [
      JSON.stringify({ type: "thread.started", thread_id: "fixture" }),
      JSON.stringify({
        item: { text: '{"reply":"done","summary":"bounded"}', type: "agent_message" },
        type: "item.completed",
      }),
    ].join("\n");

    expect(await adapter.run(input)).toEqual({
      output: { reply: "done", summary: "bounded" },
      status: "success",
      toolActivity: "none",
    });
    const execution = runner.executions[0]!;
    expect(execution.args).toContain("--ephemeral");
    expect(execution.args).toContain("--json");
    expect(execution.args.join(" ")).not.toContain("/source/src/cli.ts");
    expect(execution.args).not.toContain("--model");
    expect(execution.args).not.toContain("--sandbox");
    expect(execution.args).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(execution.args.join(" ")).not.toContain("secret-capability");
    expect(execution.args).toContain("--profile");
    expect(execution.env).toEqual({});
    expect(runner.observedCodexProfile).toContain(
      'S4IMSG_ATTEMPT_CAPABILITY = "secret-capability"',
    );
    expect(runner.observedCodexProfile).toContain(
      'args = ["/source/src/cli.ts","mcp"]',
    );
    expect(runner.observedCodexProfile).toContain(
      'S4IMSG_BROKER_URL = "http://127.0.0.1:3456"',
    );
    expect(runner.observedCodexProfileMode).toBe(0o600);
    expect(await readdir(codexHome)).toEqual([]);
    expect(execution.stdin).toBe(input.prompt);
  });

  test("creates an absent custom Codex home and removes the temporary profile", async () => {
    const parent = await mkdtemp(join(tmpdir(), "s4imsg-absent-codex-home-"));
    temporaryDirectories.push(parent);
    const codexHome = join(parent, "nested", ".codex");
    const runner = new FakeRunner();
    runner.codexHome = codexHome;
    runner.response.stdout = JSON.stringify({
      item: { text: '{"reply":"done"}', type: "agent_message" },
      type: "item.completed",
    });

    expect(
      await new CodexAdapter("/usr/local/bin/codex", runner, codexHome).run(input),
    ).toMatchObject({ status: "success" });
    expect((await stat(codexHome)).mode & 0o777).toBe(0o700);
    expect(runner.observedCodexProfile).toContain(
      'S4IMSG_ATTEMPT_CAPABILITY = "secret-capability"',
    );
    expect(await readdir(codexHome)).toEqual([]);
  });
});

describe("Claude Code adapter", () => {
  test("loads one private MCP file while bypassing approval prompts", async () => {
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
    expect(execution.args).toContain("--dangerously-skip-permissions");
    expect(execution.args.join(" ")).not.toContain("secret-capability");
    expect(runner.observedMcpConfig).toEqual({
      mcpServers: {
        s4imsg: {
          args: ["/source/src/cli.ts", "mcp"],
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
  const { adapter } = await codexAdapter(runner);
  runner.response.stdout = [
    JSON.stringify({
      item: { command: "touch file", type: "command_execution" },
      type: "item.completed",
    }),
    JSON.stringify({ item: { text: '{"reply":"done"}', type: "agent_message" }, type: "item.completed" }),
  ].join("\n");
  expect(await adapter.run(input)).toMatchObject({
    status: "success",
    toolActivity: "observed",
  });
});

test("classifies a spawn failure as replay-safe operational failure", async () => {
  const runner = new FakeRunner();
  const { adapter, codexHome } = await codexAdapter(runner, "/missing/codex");
  runner.thrown = new ProcessSpawnError(new Error("ENOENT"));
  expect(await adapter.run(input)).toEqual({
    reason: "spawn-failure",
    status: "operational-failure",
    toolActivity: "none",
  });
  expect(await readdir(codexHome)).toEqual([]);
});

test("parks an unexpected runner failure as unknown side-effect state", async () => {
  const runner = new FakeRunner();
  const { adapter } = await codexAdapter(runner);
  runner.thrown = new Error("stream disconnected after launch");
  expect(await adapter.run(input)).toEqual({
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

test("classifies configured MCP startup failure before generic authentication text", async () => {
  const runner = new FakeRunner();
  const { adapter } = await codexAdapter(runner);
  runner.response = {
    exitCode: 1,
    outputLimitExceeded: false,
    stderr: "MCP startup failed: OAuth token refresh failed: reauthorization required",
    stdout: "",
    timedOut: false,
  };
  expect(await adapter.run(input)).toEqual({
    reason: "mcp-configuration",
    status: "operational-failure",
    toolActivity: "none",
  });
});
