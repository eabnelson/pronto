import type { RuntimeKind } from "../config";

export type ToolActivity = "none" | "observed" | "unknown";

export interface RuntimeOutput {
  reply: string;
  summary?: string;
}

export interface RuntimeInput {
  bridgeExecutableArgs?: readonly string[];
  bridgeExecutablePath: string;
  brokerUrl: string;
  capability: string;
  prompt: string;
  workingDirectory: string;
}

export type RuntimeAttemptResult =
  | { output: RuntimeOutput; status: "success"; toolActivity: ToolActivity }
  | {
      reason: string;
      status: "operational-failure" | "application-failure";
      toolActivity: ToolActivity;
    };

export interface RuntimeAdapter {
  executablePath: string;
  kind: RuntimeKind;
  run(input: RuntimeInput): Promise<RuntimeAttemptResult>;
}

export function classifyProcessFailure(input: {
  outputLimitExceeded: boolean;
  stderr: string;
  timedOut: boolean;
}): { reason: string; status: "application-failure" | "operational-failure" } {
  if (input.timedOut) return { reason: "timeout", status: "operational-failure" };
  if (input.outputLimitExceeded) {
    return { reason: "output-limit", status: "operational-failure" };
  }
  const evidence = input.stderr.toLowerCase();
  if (
    evidence.includes("mcp") &&
    (evidence.includes("oauth") ||
      evidence.includes("failed to initialize") ||
      evidence.includes("startup failed"))
  ) {
    return { reason: "mcp-configuration", status: "operational-failure" };
  }
  if (
    evidence.includes("permission denied") ||
    evidence.includes("permission was denied") ||
    evidence.includes("not approved") ||
    evidence.includes("approval denied")
  ) {
    return { reason: "permission-denial", status: "application-failure" };
  }
  if (evidence.includes("auth") || evidence.includes("login")) {
    return { reason: "authentication", status: "operational-failure" };
  }
  if (evidence.includes("quota") || evidence.includes("rate limit")) {
    return { reason: "quota", status: "operational-failure" };
  }
  if (evidence.includes("network") || evidence.includes("connect")) {
    return { reason: "offline", status: "operational-failure" };
  }
  return { reason: "process-failure", status: "operational-failure" };
}

export function validateRuntimeOutput(value: unknown): RuntimeOutput | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const output = value as Record<string, unknown>;
  if (typeof output.reply !== "string") return null;
  const reply = output.reply.trim();
  if (reply.length === 0 || reply.length > 4_000) return null;
  if (output.summary !== undefined) {
    if (typeof output.summary !== "string") return null;
    const summary = output.summary.trim();
    if (summary.length === 0 || summary.length > 4_000) return null;
    return { reply, summary };
  }
  return { reply };
}

export const RUNTIME_OUTPUT_SCHEMA = {
  additionalProperties: false,
  properties: {
    reply: { maxLength: 4_000, minLength: 1, type: "string" },
    summary: { maxLength: 4_000, minLength: 1, type: "string" },
  },
  required: ["reply"],
  type: "object",
} as const;
