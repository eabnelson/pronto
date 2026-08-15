import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BoundedProcessRunner, ProcessSpawnError, type ProcessRunner } from "./process";
import {
  RUNTIME_OUTPUT_SCHEMA,
  classifyProcessFailure,
  validateRuntimeOutput,
  type RuntimeAdapter,
  type RuntimeAttemptResult,
  type RuntimeInput,
  type ToolActivity,
} from "./types";

function parseClaude(stdout: string): { output: unknown; toolActivity: ToolActivity } {
  let output: unknown = null;
  let toolActivity: ToolActivity = "none";
  for (const line of stdout.split("\n")) {
    if (line.trim().length === 0) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      toolActivity = toolActivity === "observed" ? "observed" : "unknown";
      continue;
    }
    if (event.type === "system" || event.type === "rate_limit_event") continue;
    if (event.type === "assistant") {
      const message =
        event.message !== null && typeof event.message === "object"
          ? (event.message as Record<string, unknown>)
          : {};
      if (
        Array.isArray(message.content) &&
        message.content.some(
          (block) =>
            block !== null &&
            typeof block === "object" &&
            (block as Record<string, unknown>).type === "tool_use",
        )
      ) {
        toolActivity = "observed";
      }
      continue;
    }
    if (event.type === "user") {
      toolActivity = "observed";
      continue;
    }
    if (event.type === "result") {
      if (event.subtype === "success") {
        if (event.structured_output !== undefined) output = event.structured_output;
        else if (typeof event.result === "string") {
          try {
            output = JSON.parse(event.result);
          } catch {
            output = null;
          }
        }
      }
      continue;
    }
    toolActivity = toolActivity === "observed" ? "observed" : "unknown";
  }
  return { output, toolActivity };
}

export class ClaudeAdapter implements RuntimeAdapter {
  readonly kind = "claude" as const;

  constructor(
    readonly executablePath: string,
    readonly runner: ProcessRunner = new BoundedProcessRunner(),
  ) {}

  async run(input: RuntimeInput): Promise<RuntimeAttemptResult> {
    const directory = await mkdtemp(join(tmpdir(), "s4imsg-claude-"));
    await chmod(directory, 0o700);
    const mcpPath = join(directory, "mcp.json");
    await writeFile(
      mcpPath,
      JSON.stringify({
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
      }),
      { mode: 0o600 },
    );
    try {
      let execution;
      try {
        execution = await this.runner.run({
        args: [
          "-p",
          "--output-format",
          "stream-json",
          "--verbose",
          "--no-session-persistence",
          "--json-schema",
          JSON.stringify(RUNTIME_OUTPUT_SCHEMA),
          "--mcp-config",
          mcpPath,
        ],
        env: {},
        executable: this.executablePath,
        stdin: input.prompt,
        workingDirectory: input.workingDirectory,
        });
      } catch (error) {
        return {
          reason: error instanceof ProcessSpawnError ? "spawn-failure" : "runner-failure",
          status: "operational-failure",
          toolActivity: error instanceof ProcessSpawnError ? "none" : "unknown",
        };
      }
      const parsed = parseClaude(execution.stdout);
      if (execution.exitCode !== 0) {
        return {
          ...classifyProcessFailure(execution),
          toolActivity:
            execution.outputLimitExceeded && parsed.toolActivity === "none"
              ? "unknown"
              : parsed.toolActivity,
        };
      }
      const output = validateRuntimeOutput(parsed.output);
      return output === null
        ? {
            reason: "invalid-output",
            status: "application-failure",
            toolActivity: parsed.toolActivity,
          }
        : { output, status: "success", toolActivity: parsed.toolActivity };
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }
}
