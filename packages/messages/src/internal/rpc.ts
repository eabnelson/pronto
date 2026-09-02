import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

interface PendingRequest {
  readonly reject: (error: Error) => void;
  readonly resolve: (value: unknown) => void;
  readonly timeout: ReturnType<typeof setTimeout>;
}

export interface RpcNotification {
  readonly method: string;
  readonly params?: unknown;
}

export class RpcRequestError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "RpcRequestError";
  }
}

export class ImsgRpcClient {
  readonly terminated: Promise<void>;
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #handlers = new Set<(notification: RpcNotification) => void>();
  readonly #pending = new Map<string, PendingRequest>();
  #buffer = "";
  #closed = false;
  #nextId = 1;
  #resolveTerminated!: () => void;

  constructor(command: string) {
    this.#child = spawn(command, ["rpc"], { stdio: ["pipe", "pipe", "pipe"] });
    this.#child.stderr.resume();
    this.terminated = new Promise((resolve) => {
      this.#resolveTerminated = resolve;
    });
    this.#child.stdout.on("data", (chunk: Buffer | string) => this.#onData(chunk));
    this.#child.once("error", (error) => this.#fail(error));
    this.#child.once("exit", () => this.#fail(new Error("imsg RPC process exited")));
  }

  onNotification(handler: (notification: RpcNotification) => void): () => void {
    this.#handlers.add(handler);
    return () => this.#handlers.delete(handler);
  }

  request(
    method: string,
    params: Readonly<Record<string, unknown>> = {},
    timeoutMs = 30_000,
  ): Promise<unknown> {
    if (this.#closed) return Promise.reject(new Error("imsg RPC client is closed"));
    const id = String(this.#nextId++);
    return new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`imsg RPC request timed out: ${method}`));
      }, timeoutMs);
      this.#pending.set(id, { reject, resolve, timeout });
      this.#child.stdin.write(
        `${JSON.stringify({ id, jsonrpc: "2.0", method, params })}\n`,
        (error) => {
          if (error === null || error === undefined) return;
          const pending = this.#pending.get(id);
          if (pending === undefined) return;
          this.#pending.delete(id);
          clearTimeout(pending.timeout);
          pending.reject(new Error("Unable to write imsg RPC request"));
        },
      );
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#child.stdin.end();
    this.#child.kill("SIGTERM");
    await this.terminated;
  }

  #onData(chunk: Buffer | string): void {
    this.#buffer += chunk.toString();
    while (true) {
      const newline = this.#buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.#buffer.slice(0, newline).trim();
      this.#buffer = this.#buffer.slice(newline + 1);
      if (line !== "") this.#handleLine(line);
    }
  }

  #handleLine(line: string): void {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      this.#fail(new Error("imsg emitted invalid JSON-RPC output"));
      return;
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)) return;
    const message = value as Record<string, unknown>;
    if (typeof message.method === "string" && message.id === undefined) {
      for (const handler of this.#handlers) {
        handler({
          method: message.method,
          ...(message.params === undefined ? {} : { params: message.params }),
        });
      }
      return;
    }
    if (typeof message.id !== "string" && typeof message.id !== "number") return;
    const id = String(message.id);
    const pending = this.#pending.get(id);
    if (pending === undefined) return;
    this.#pending.delete(id);
    clearTimeout(pending.timeout);
    if (message.error !== null && typeof message.error === "object") {
      const error = message.error as Record<string, unknown>;
      pending.reject(new RpcRequestError(
        typeof error.code === "number" ? error.code : -32603,
        typeof error.message === "string" ? error.message : "imsg RPC error",
        error.data,
      ));
    } else {
      pending.resolve(message.result);
    }
  }

  #fail(error: Error): void {
    if (this.#closed && this.#pending.size === 0) {
      this.#resolveTerminated();
      return;
    }
    this.#closed = true;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.#pending.clear();
    this.#resolveTerminated();
  }
}
