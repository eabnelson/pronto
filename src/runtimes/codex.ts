import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  BoundedProcessRunner,
  ProcessSpawnError,
  type ProcessExecution,
  type ProcessRunner,
} from "./process";
import {
  RUNTIME_OUTPUT_SCHEMA,
  classifyProcessFailure,
  validateRuntimeOutput,
  type RuntimeAdapter,
  type RuntimeAttemptResult,
  type RuntimeInput,
  type ToolActivity,
} from "./types";

function activity(current: ToolActivity, next: ToolActivity): ToolActivity {
  if (current === "observed" || next === "observed") return "observed";
  if (current === "unknown" || next === "unknown") return "unknown";
  return "none";
}

function parseCodex(stdout: string): { output: unknown; toolActivity: ToolActivity } {
  let output: unknown = null;
  let toolActivity: ToolActivity = "none";
  for (const line of stdout.split("\n")) {
    if (line.trim().length === 0) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      toolActivity = activity(toolActivity, "unknown");
      continue;
    }
    const type = event.type;
    if (
      type === "thread.started" ||
      type === "turn.started" ||
      type === "turn.completed" ||
      type === "turn.failed" ||
      type === "error"
    ) {
      continue;
    }
    if (type !== "item.started" && type !== "item.completed") {
      toolActivity = activity(toolActivity, "unknown");
      continue;
    }
    const item =
      event.item !== null && typeof event.item === "object"
        ? (event.item as Record<string, unknown>)
        : {};
    if (item.type === "agent_message" && typeof item.text === "string") {
      try {
        output = JSON.parse(item.text);
      } catch {
        output = null;
      }
    } else if (item.type === "reasoning") {
      continue;
    } else if (
      item.type === "command_execution" ||
      item.type === "mcp_tool_call" ||
      item.type === "file_change"
    ) {
      toolActivity = "observed";
    } else {
      toolActivity = activity(toolActivity, "unknown");
    }
  }
  return { output, toolActivity };
}

export class CodexAdapter implements RuntimeAdapter {
  readonly kind = "codex" as const;

  constructor(
    readonly executablePath: string,
    readonly runner: ProcessRunner = new BoundedProcessRunner(),
  ) {}

  async run(input: RuntimeInput): Promise<RuntimeAttemptResult> {
    const directory = await mkdtemp(join(tmpdir(), "s4imsg-codex-"));
    await chmod(directory, 0o700);
    const schemaPath = join(directory, "output-schema.json");
    await writeFile(schemaPath, JSON.stringify(RUNTIME_OUTPUT_SCHEMA), { mode: 0o600 });
    try {
      let execution: ProcessExecution;
      try {
        execution = await this.runner.run({
        args: [
          "exec",
          "--ephemeral",
          "--json",
          "--color",
          "never",
          "--skip-git-repo-check",
          "--output-schema",
          schemaPath,
          "-C",
          input.workingDirectory,
          "-c",
          `mcp_servers.s4imsg.command=${JSON.stringify(input.bridgeExecutablePath)}`,
          "-c",
          'mcp_servers.s4imsg.args=["mcp"]',
          "-c",
          'mcp_servers.s4imsg.env_vars=["S4IMSG_BROKER_URL","S4IMSG_ATTEMPT_CAPABILITY"]',
          "-",
        ],
        env: {
          S4IMSG_ATTEMPT_CAPABILITY: input.capability,
          S4IMSG_BROKER_URL: input.brokerUrl,
        },
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
      const parsed = parseCodex(execution.stdout);
      if (execution.exitCode !== 0) {
        const failure = classifyProcessFailure(execution);
        return {
          ...failure,
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
