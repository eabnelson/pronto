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
}

export class NdjsonRpcClient implements ImsgRpc {
  readonly #child: Bun.Subprocess<"pipe", "pipe", "pipe">;
  readonly #handlers = new Map<string, Set<NotificationHandler>>();
  readonly #pending = new Map<number, PendingRequest>();
  #nextId = 1;
  #readTask: Promise<void>;

  constructor(executablePath: string) {
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
    return () => handlers.delete(handler);
  }

  async call(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = this.#nextId++;
    const result = new Promise<unknown>((resolve, reject) => {
      this.#pending.set(id, { reject, resolve });
    });
    this.#child.stdin.write(`${JSON.stringify({ id, jsonrpc: "2.0", method, params })}\n`);
    await this.#child.stdin.flush();
    return result;
  }

  async close(): Promise<void> {
    this.#child.stdin.end();
    await this.#readTask;
    await this.#child.exited;
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
          if (line.length > 0) await this.#handleLine(line);
        }
      }
    } finally {
      const error = new Error("imsg RPC process closed");
      for (const pending of this.#pending.values()) pending.reject(error);
      this.#pending.clear();
      reader.releaseLock();
    }
  }

  async #handleLine(line: string): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error("imsg emitted invalid JSON-RPC output");
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return;
    const message = parsed as Record<string, unknown>;
    if (typeof message.method === "string" && !("id" in message)) {
      for (const handler of this.#handlers.get(message.method) ?? []) {
        await handler(message.params);
      }
      return;
    }
    if (typeof message.id !== "number") return;
    const pending = this.#pending.get(message.id);
    if (pending === undefined) return;
    this.#pending.delete(message.id);
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
}
