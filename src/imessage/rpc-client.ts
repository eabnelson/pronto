export interface ImsgRpc {
  call(method: string, params?: Record<string, unknown>): Promise<unknown>;
}

export interface WatchableImsgRpc extends ImsgRpc {
  on(method: string, handler: (params: unknown) => void | Promise<void>): () => void;
}

export class ImsgRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "ImsgRpcError";
  }
}

type NotificationHandler = (params: unknown) => void | Promise<void>;

interface PendingRequest {
  reject: (error: Error) => void;
  resolve: (value: unknown) => void;
  timeout: ReturnType<typeof setTimeout>;
}

export interface NdjsonRpcClientOptions {
  closeTimeoutMs?: number;
  requestTimeoutMs?: number;
}

export class NdjsonRpcClient implements ImsgRpc {
  readonly terminated: Promise<void>;
  readonly #child: Bun.Subprocess<"pipe", "pipe", "pipe">;
  readonly #handlers = new Map<string, Set<NotificationHandler>>();
  readonly #pending = new Map<number, PendingRequest>();
  readonly #closeTimeoutMs: number;
  readonly #requestTimeoutMs: number;
  #closeTask: Promise<void> | null = null;
  #nextId = 1;
  #notificationTask = Promise.resolve();
  #readError: Error | null = null;
  #resolveTerminated!: () => void;
  #readTask: Promise<void>;

  constructor(executablePath: string, options: NdjsonRpcClientOptions = {}) {
    this.#closeTimeoutMs = options.closeTimeoutMs ?? 2_000;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.terminated = new Promise<void>((resolve) => {
      this.#resolveTerminated = resolve;
    });
    this.#child = Bun.spawn([executablePath, "rpc"], {
      stderr: "pipe",
      stdin: "pipe",
      stdout: "pipe",
    });
    this.#readTask = this.#readLoop();
  }

  on(method: string, handler: NotificationHandler): () => void {
    const handlers = this.#handlers.get(method) ?? new Set();
    handlers.add(handler);
    this.#handlers.set(method, handlers);
    return () => {
      handlers.delete(handler);
      if (handlers.size === 0) this.#handlers.delete(method);
    };
  }

  async call(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (this.#readError !== null) throw this.#readError;
    const id = this.#nextId++;
    const result = new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this.#pending.delete(id)) reject(new Error(`imsg RPC request timed out: ${method}`));
      }, this.#requestTimeoutMs);
      this.#pending.set(id, { reject, resolve, timeout });
    });
    try {
      this.#child.stdin.write(`${JSON.stringify({ id, jsonrpc: "2.0", method, params })}\n`);
      await this.#child.stdin.flush();
    } catch (error) {
      const pending = this.#pending.get(id);
      if (pending !== undefined) {
        this.#pending.delete(id);
        clearTimeout(pending.timeout);
        pending.reject(error instanceof Error ? error : new Error("Unable to write imsg RPC request"));
      }
    }
    return await result;
  }

  async close(): Promise<void> {
    this.#closeTask ??= this.#close();
    await this.#closeTask;
  }

  async #readLoop(): Promise<void> {
    const reader = this.#child.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        while (true) {
          const newline = buffer.indexOf("\n");
          if (newline < 0) break;
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line.length > 0) this.#handleLine(line);
        }
      }
    } catch (error) {
      this.#readError =
        error instanceof Error ? error : new Error("imsg RPC reader failed unexpectedly");
    } finally {
      const error = this.#readError ?? new Error("imsg RPC process closed");
      for (const pending of this.#pending.values()) {
        clearTimeout(pending.timeout);
        pending.reject(error);
      }
      this.#pending.clear();
      reader.releaseLock();
      this.#resolveTerminated();
    }
  }

  #handleLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error("imsg emitted invalid JSON-RPC output");
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return;
    const message = parsed as Record<string, unknown>;
    if (typeof message.method === "string" && !("id" in message)) {
      const handlers = [...(this.#handlers.get(message.method) ?? [])];
      this.#notificationTask = this.#notificationTask.then(async () => {
        for (const handler of handlers) {
          try {
            await handler(message.params);
          } catch {
            console.error(
              JSON.stringify({ component: "imsg-rpc", state: "notification-handler-failed" }),
            );
          }
        }
      });
      return;
    }
    if (typeof message.id !== "number") return;
    const pending = this.#pending.get(message.id);
    if (pending === undefined) return;
    this.#pending.delete(message.id);
    clearTimeout(pending.timeout);
    if (message.error !== null && typeof message.error === "object") {
      const error = message.error as Record<string, unknown>;
      pending.reject(
        new ImsgRpcError(
          typeof error.code === "number" ? error.code : -32603,
          typeof error.message === "string" ? error.message : "imsg RPC error",
          error.data,
        ),
      );
    } else {
      pending.resolve(message.result);
    }
  }

  async #close(): Promise<void> {
    await Promise.race([this.#notificationTask, Bun.sleep(this.#closeTimeoutMs)]);
    try {
      this.#child.stdin.end();
    } catch {
      // The child may already have closed its input.
    }
    if (!(await this.#exitedWithin(this.#closeTimeoutMs))) {
      this.#child.kill("SIGTERM");
      if (!(await this.#exitedWithin(this.#closeTimeoutMs))) this.#child.kill("SIGKILL");
    }
    await this.#readTask;
    await this.#child.exited;
  }

  async #exitedWithin(timeoutMs: number): Promise<boolean> {
    return await Promise.race([
      this.#child.exited.then(() => true),
      Bun.sleep(timeoutMs).then(() => false),
    ]);
  }
}
