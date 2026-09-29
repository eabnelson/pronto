import { spawn, type ChildProcess } from "node:child_process";

export interface CommandResult {
  readonly code: number | null;
  /** Set when the executable could not be started at all. */
  readonly spawnError: string | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;
  readonly stdout: string;
  readonly timedOut: boolean;
}

export interface CommandOptions {
  readonly maxOutputBytes?: number;
  readonly signal?: AbortSignal;
  readonly timeoutMs: number;
}

const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const KILL_GRACE_MS = 2_000;

class BoundedBuffer {
  readonly #chunks: Buffer[] = [];
  #size = 0;

  constructor(private readonly limit: number) {}

  push(chunk: Buffer): void {
    if (this.#size >= this.limit) return;
    const room = this.limit - this.#size;
    const kept = chunk.length > room ? chunk.subarray(0, room) : chunk;
    this.#chunks.push(kept);
    this.#size += kept.length;
  }

  text(): string {
    return Buffer.concat(this.#chunks).toString("utf8");
  }
}

export function spawnWacli(path: string, args: readonly string[]): ChildProcess {
  return spawn(path, [...args], {
    env: process.env,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** Runs one bounded wacli invocation and collects its output. Never throws. */
export async function runCommand(
  path: string,
  args: readonly string[],
  options: CommandOptions,
): Promise<CommandResult> {
  const limit = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const stdout = new BoundedBuffer(limit);
  const stderr = new BoundedBuffer(limit);
  let child: ChildProcess;
  try {
    child = spawnWacli(path, args);
  } catch (error) {
    return failedSpawn(error);
  }
  child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));

  return await new Promise<CommandResult>((resolvePromise) => {
    let timedOut = false;
    let spawned = false;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;
    const resolve = (result: CommandResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer !== undefined) clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", onAbort);
      resolvePromise(result);
    };
    const terminate = () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
      killTimer.unref();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, options.timeoutMs);
    timer.unref();
    const onAbort = () => terminate();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) terminate();
    child.once("spawn", () => {
      spawned = true;
    });
    child.once("error", (error) => {
      if (!spawned) resolve(failedSpawn(error));
    });
    child.once("close", (code, signal) => {
      resolve({
        code,
        signal,
        spawnError: null,
        stderr: stderr.text(),
        stdout: stdout.text(),
        timedOut,
      });
    });
  });
}

function failedSpawn(error: unknown): CommandResult {
  return {
    code: null,
    signal: null,
    spawnError: error instanceof Error ? error.message : String(error),
    stderr: "",
    stdout: "",
    timedOut: false,
  };
}

export interface Envelope {
  readonly data: unknown;
  readonly error: string | null;
  readonly success: boolean;
}

/** Finds wacli's `{success,data,error}` JSON envelope on stdout, or on stderr for failures. */
export function parseEnvelope(result: Pick<CommandResult, "stderr" | "stdout">): Envelope | null {
  return envelopeIn(result.stdout) ?? envelopeIn(result.stderr);
}

function envelopeIn(text: string): Envelope | null {
  const lines = text.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim() ?? "";
    if (!line.startsWith("{")) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(value) || typeof value.success !== "boolean") continue;
    return {
      data: value.data ?? null,
      error: typeof value.error === "string" ? value.error : null,
      success: value.success,
    };
  }
  return null;
}

/** Last `{"event":"error"}` message or plain stderr line, for diagnostics. */
export function describeFailure(result: CommandResult): string {
  if (result.spawnError !== null) return result.spawnError;
  if (result.timedOut) return "wacli timed out";
  const envelope = parseEnvelope(result);
  if (envelope?.error) return envelope.error;
  const lines = result.stderr.split("\n").map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index] ?? "";
    try {
      const value: unknown = JSON.parse(line);
      if (isRecord(value) && value.event === "error" && isRecord(value.data)
        && typeof value.data.message === "string") {
        return value.data.message;
      }
    } catch {
      return line.slice(0, 500);
    }
  }
  return `wacli exited with ${result.code ?? result.signal ?? "unknown status"}`;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
