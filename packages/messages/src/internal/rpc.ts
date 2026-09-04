import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

interface PendingRequest {
  readonly method: string;
  readonly reject: (error: Error) => void;
  readonly resolve: (value: unknown) => void;
  readonly timeout: ReturnType<typeof setTimeout>;
}

export class RpcSubmissionUncertainError extends Error {
  constructor() {
    super("imsg send outcome is uncertain");
    this.name = "RpcSubmissionUncertainError";
  }
}

export interface RpcNotification {
  readonly method: string;
  readonly params?: unknown;
}

export interface RpcConnection {
  close(): Promise<void>;
  onFailure(handler: (reason: string) => void): () => void;
  onNotification(handler: (notification: RpcNotification) => void): () => void;
  request(
    method: string,
    params?: Readonly<Record<string, unknown>>,
    timeoutMs?: number,
  ): Promise<unknown>;
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

export class ImsgRpcClient implements RpcConnection {
  readonly terminated: Promise<void>;
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #handlers = new Set<(notification: RpcNotification) => void>();
  readonly #failureHandlers = new Set<(reason: string) => void>();
  readonly #pending = new Map<string, PendingRequest>();
  readonly #idleShutdownGraceMs: number;
  readonly #shutdownGraceMs: number;
  readonly #terminationGraceMs: number;
  #buffer = "";
  #closePromise: Promise<void> | undefined;
  #closed = false;
  #failed = false;
  #nextId = 1;
  #resolveTerminated!: () => void;

  constructor(command: string, options: {
    readonly idleShutdownGraceMs?: number;
    readonly shutdownGraceMs?: number;
    readonly terminationGraceMs?: number;
  } = {}) {
    this.#shutdownGraceMs = options.shutdownGraceMs ?? 5_000;
    this.#idleShutdownGraceMs = options.idleShutdownGraceMs ??
      Math.min(250, this.#shutdownGraceMs);
    this.#terminationGraceMs = options.terminationGraceMs ?? 2_000;
    this.#child = spawn(command, ["rpc"], { stdio: ["pipe", "pipe", "pipe"] });
    this.#child.stderr.resume();
    this.terminated = new Promise((resolve) => {
      this.#resolveTerminated = resolve;
    });
    this.#child.stdout.on("data", (chunk: Buffer | string) => this.#onData(chunk));
    this.#child.once("error", (error) => this.#fail("spawn-error", error));
    this.#child.once("close", () => {
      this.#fail("process-exit", new Error("imsg RPC process exited"));
    });
  }

  onNotification(handler: (notification: RpcNotification) => void): () => void {
    this.#handlers.add(handler);
    return () => this.#handlers.delete(handler);
  }

  onFailure(handler: (reason: string) => void): () => void {
    this.#failureHandlers.add(handler);
    return () => this.#failureHandlers.delete(handler);
  }

  request(
    method: string,
    params: Readonly<Record<string, unknown>> = {},
    timeoutMs = 30_000,
  ): Promise<unknown> {
    if (this.#closed || this.#failed) {
      return Promise.reject(new Error("imsg RPC client is unavailable"));
    }
    const id = String(this.#nextId++);
    return new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        reject(method === "send"
          ? new RpcSubmissionUncertainError()
          : new Error(`imsg RPC request timed out: ${method}`));
      }, timeoutMs);
      this.#pending.set(id, { method, reject, resolve, timeout });
      this.#child.stdin.write(
        `${JSON.stringify({ id, jsonrpc: "2.0", method, params })}\n`,
        (error) => {
          if (error === null || error === undefined) return;
          const pending = this.#pending.get(id);
          if (pending === undefined) return;
          this.#pending.delete(id);
          clearTimeout(pending.timeout);
          pending.reject(pending.method === "send"
            ? new RpcSubmissionUncertainError()
            : new Error("Unable to write imsg RPC request"));
        },
      );
    });
  }

  async close(): Promise<void> {
    if (this.#closePromise !== undefined) return await this.#closePromise;
    this.#closed = true;
    this.#closePromise = this.#shutdown();
    await this.#closePromise;
  }

  async #shutdown(): Promise<void> {
    this.#child.stdin.end();
    const graceMs = this.#pending.size === 0
      ? this.#idleShutdownGraceMs
      : this.#shutdownGraceMs;
    if (await this.#waitForTermination(graceMs)) return;
    this.#child.kill("SIGTERM");
    if (await this.#waitForTermination(this.#terminationGraceMs)) return;
    this.#child.kill("SIGKILL");
    await this.terminated;
  }

  async #waitForTermination(milliseconds: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.terminated.then(() => true),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), milliseconds);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
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
      this.#fail("malformed-output", new Error("imsg emitted invalid JSON-RPC output"));
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

  #fail(reason: string, error: Error): void {
    if (this.#closed && this.#pending.size === 0) {
      this.#resolveTerminated();
      return;
    }
    if (this.#failed) return;
    this.#failed = true;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(pending.method === "send" ? new RpcSubmissionUncertainError() : error);
    }
    this.#pending.clear();
    this.#resolveTerminated();
    for (const handler of this.#failureHandlers) handler(reason);
    this.#child.kill("SIGTERM");
  }
}

export interface RpcDiagnostics {
  readonly attempt: number;
  readonly nextRetryAt?: string;
  readonly restartCount: number;
  readonly state: "ready" | "recovering";
}

export class ResilientRpcClient {
  readonly terminated: Promise<void>;
  readonly #connect: () => RpcConnection;
  readonly #wait: (milliseconds: number) => Promise<void>;
  readonly #now: () => number;
  readonly #random: () => number;
  readonly #notifications = new Set<(notification: RpcNotification) => void>();
  readonly #restartHandlers = new Set<() => void>();
  readonly #closeWaiters = new Set<() => void>();
  #connection: RpcConnection;
  #disposeConnection: (() => void)[] = [];
  #restart: Promise<void> | undefined;
  #restartCount = 0;
  #closed = false;
  #resolveTerminated!: () => void;
  #diagnostics: RpcDiagnostics = { attempt: 0, restartCount: 0, state: "ready" };
  #backoffMs = 1_000;
  #healthySince: number;

  constructor(input: {
    readonly connect: () => RpcConnection;
    readonly now?: () => number;
    readonly random?: () => number;
    readonly wait?: (milliseconds: number) => Promise<void>;
  }) {
    this.#connect = input.connect;
    this.#now = input.now ?? Date.now;
    this.#healthySince = this.#now();
    this.#random = input.random ?? Math.random;
    this.#wait = input.wait ?? (async (milliseconds) => {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, milliseconds);
        timer.unref?.();
      });
    });
    this.terminated = new Promise((resolve) => {
      this.#resolveTerminated = resolve;
    });
    this.#connection = this.#connect();
    this.#bind(this.#connection);
  }

  static spawn(command: string): ResilientRpcClient {
    return new ResilientRpcClient({ connect: () => new ImsgRpcClient(command) });
  }

  diagnostics(): RpcDiagnostics {
    return this.#diagnostics;
  }

  onNotification(handler: (notification: RpcNotification) => void): () => void {
    this.#notifications.add(handler);
    return () => this.#notifications.delete(handler);
  }

  onRestart(handler: () => void): () => void {
    this.#restartHandlers.add(handler);
    return () => this.#restartHandlers.delete(handler);
  }

  async request(
    method: string,
    params: Readonly<Record<string, unknown>> = {},
    timeoutMs = 30_000,
  ): Promise<unknown> {
    const deadline = this.#now() + timeoutMs;
    if (this.#restart !== undefined) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let closed: (() => void) | undefined;
      try {
        await Promise.race([
          this.#restart,
          new Promise<never>((_resolve, reject) => {
            closed = () => reject(new Error("imsg RPC client is closed"));
            this.#closeWaiters.add(closed);
            if (this.#closed) closed();
          }),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(
              new Error(`imsg RPC request timed out before submission: ${method}`),
            ), timeoutMs);
          }),
        ]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        if (closed !== undefined) this.#closeWaiters.delete(closed);
      }
    }
    if (this.#closed) throw new Error("imsg RPC client is closed");
    const remaining = deadline - this.#now();
    if (remaining <= 0) throw new Error(`imsg RPC request timed out before submission: ${method}`);
    // A request submitted to a failed process rejects from that process. It is
    // deliberately never replayed here, especially when the method is `send`.
    return await this.#connection.request(method, params, remaining);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const closed of this.#closeWaiters) closed();
    this.#closeWaiters.clear();
    for (const dispose of this.#disposeConnection.splice(0)) dispose();
    await this.#connection.close().catch(() => undefined);
    this.#resolveTerminated();
  }

  #bind(connection: RpcConnection): void {
    this.#disposeConnection = [
      connection.onNotification((notification) => {
        for (const handler of this.#notifications) handler(notification);
      }),
      connection.onFailure(() => this.#beginRestart(connection)),
    ];
  }

  #beginRestart(failed: RpcConnection): void {
    if (this.#closed || failed !== this.#connection || this.#restart !== undefined) return;
    if (this.#now() - this.#healthySince >= 30_000) this.#backoffMs = 1_000;
    this.#restart = this.#restartLoop(failed).finally(() => {
      this.#restart = undefined;
    });
  }

  async #restartLoop(failed: RpcConnection): Promise<void> {
    for (const dispose of this.#disposeConnection.splice(0)) dispose();
    await failed.close().catch(() => undefined);
    let attempt = 1;
    while (!this.#closed) {
      const delayMs = Math.min(
        60_000,
        Math.max(1, Math.round(this.#backoffMs * (0.8 + this.#random() * 0.4))),
      );
      this.#diagnostics = {
        attempt,
        nextRetryAt: new Date(this.#now() + delayMs).toISOString(),
        restartCount: this.#restartCount,
        state: "recovering",
      };
      await this.#wait(delayMs);
      if (this.#closed) return;
      let next: RpcConnection | undefined;
      try {
        next = this.#connect();
        await next.request("initialize", { protocol_version: 1 }, 10_000);
        if (this.#closed) {
          await next.close().catch(() => undefined);
          return;
        }
        this.#connection = next;
        this.#healthySince = this.#now();
        this.#bind(next);
        this.#restartCount += 1;
        this.#backoffMs = Math.min(60_000, this.#backoffMs * 2);
        this.#diagnostics = {
          attempt: 0,
          restartCount: this.#restartCount,
          state: "ready",
        };
        for (const handler of this.#restartHandlers) handler();
        return;
      } catch {
        await next?.close().catch(() => undefined);
        this.#backoffMs = Math.min(60_000, this.#backoffMs * 2);
        attempt += 1;
      }
    }
  }
}
