import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ImsgRpcClient,
  ResilientRpcClient,
  type RpcConnection,
  type RpcNotification,
} from "../src/internal/rpc";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

async function executable(source: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pronto-rpc-lifecycle-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "imsg-fixture");
  await writeFile(path, `#!/usr/bin/env bun\n${source}`, { mode: 0o700 });
  await chmod(path, 0o700);
  return path;
}

class FakeConnection implements RpcConnection {
  readonly methods: string[] = [];
  readonly #failureHandlers = new Set<(reason: string) => void>();
  readonly #notificationHandlers = new Set<(notification: RpcNotification) => void>();
  rejectSend: ((error: Error) => void) | undefined;

  async close(): Promise<void> {}

  fail(): void {
    this.rejectSend?.(new Error("imsg RPC process exited"));
    for (const handler of this.#failureHandlers) handler("process-exit");
  }

  onFailure(handler: (reason: string) => void): () => void {
    this.#failureHandlers.add(handler);
    return () => this.#failureHandlers.delete(handler);
  }

  onNotification(handler: (notification: RpcNotification) => void): () => void {
    this.#notificationHandlers.add(handler);
    return () => this.#notificationHandlers.delete(handler);
  }

  request(method: string): Promise<unknown> {
    this.methods.push(method);
    if (method === "send") {
      return new Promise((_resolve, reject) => {
        this.rejectSend = reject;
      });
    }
    return Promise.resolve({ protocol_version: 1 });
  }
}

test.each([0, 60_000])("resets reconnect delay after stable health, not a flap (%i ms)", async (healthyMs) => {
  const connections: FakeConnection[] = [];
  const delays: number[] = [];
  let now = 0;
  const rpc = new ResilientRpcClient({
    connect: () => { const connection = new FakeConnection(); connections.push(connection); return connection; },
    now: () => now, random: () => 0.5,
    wait: async (delay) => { delays.push(delay); },
  });
  try {
    for (let index = 0; index < 2; index += 1) {
      if (index === 1) now += healthyMs;
      const restarted = new Promise<void>((resolve) => {
        const dispose = rpc.onRestart(() => { dispose(); resolve(); });
      });
      connections[index]!.fail();
      await restarted;
      await rpc.request("status");
    }
    expect(delays).toEqual(healthyMs === 0 ? [1_000, 2_000] : [1_000, 1_000]);
  } finally {
    await rpc.close();
  }
});

test("expires a request while reconnecting without submitting it later", async () => {
  const connections: FakeConnection[] = [];
  const resume = Promise.withResolvers<void>();
  const rpc = new ResilientRpcClient({
    connect: () => { const connection = new FakeConnection(); connections.push(connection); return connection; },
    wait: async () => await resume.promise,
  });
  try {
    connections[0]!.fail();
    const request = rpc.request("send", { text: "never submit this expired request" }, 10)
      .then(() => "submitted", (error: Error) => error.message);
    expect(await Promise.race([request, Bun.sleep(100).then(() => "stalled")]))
      .toBe("imsg RPC request timed out before submission: send");
    resume.resolve();
    await rpc.request("status");
    expect(connections.flatMap((connection) => connection.methods)).not.toContain("send");
  } finally {
    resume.resolve();
    await rpc.close();
  }
});

test("retries a failed connection factory without escaping the recovery loop", async () => {
  const first = new FakeConnection();
  let calls = 0;
  const rpc = new ResilientRpcClient({
    connect: () => {
      calls += 1;
      if (calls === 1) return first;
      if (calls === 2) throw new Error("synthetic spawn failure");
      return new FakeConnection();
    },
    wait: async () => undefined,
  });
  try {
    first.fail();
    await expect(rpc.request("status")).resolves.toEqual({ protocol_version: 1 });
    expect(calls).toBe(3);
  } finally {
    await rpc.close();
  }
});

test("restarts the provider but never replays an already submitted send", async () => {
  const connections: FakeConnection[] = [];
  const rpc = new ResilientRpcClient({
    connect: () => {
      const connection = new FakeConnection();
      connections.push(connection);
      return connection;
    },
    wait: async () => undefined,
  });
  const restarted = new Promise<void>((resolve) => rpc.onRestart(resolve));

  const send = rpc.request("send", { chat_id: 42, text: "one external effect" });
  await Promise.resolve();
  connections[0]!.fail();

  await expect(send).rejects.toThrow("process exited");
  await restarted;
  expect(connections).toHaveLength(2);
  expect(connections[0]!.methods).toEqual(["send"]);
  expect(connections[1]!.methods).toEqual(["initialize"]);
  expect(rpc.diagnostics()).toEqual({
    attempt: 0,
    restartCount: 1,
    state: "ready",
  });
  await rpc.close();
});

test("drains an accepted request before closing the provider", async () => {
  const command = await executable(`
const decoder = new TextDecoder();
let buffer = "";
for await (const chunk of Bun.stdin.stream()) {
  buffer += decoder.decode(chunk, { stream: true });
  while (buffer.includes("\\n")) {
    const newline = buffer.indexOf("\\n");
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (line.trim() === "") continue;
    const request = JSON.parse(line);
    await Bun.sleep(50);
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: request.id,
      result: { ok: true, guid: "drained-guid" },
    }) + "\\n");
  }
}
`);
  const rpc = new ImsgRpcClient(command, {
    shutdownGraceMs: 1_000,
    terminationGraceMs: 100,
  });
  const request = rpc.request("send", { chat_id: 42, text: "drain me" });
  const close = rpc.close();
  await expect(request).resolves.toEqual({ ok: true, guid: "drained-guid" });
  await close;
});

test("force-terminates a provider that does not exit after EOF", async () => {
  const command = await executable(`
process.on("SIGTERM", () => undefined);
process.stdin.resume();
setInterval(() => undefined, 1_000);
`);
  const rpc = new ImsgRpcClient(command, {
    shutdownGraceMs: 50,
    terminationGraceMs: 50,
  });
  const startedAt = Date.now();
  await rpc.close();
  expect(Date.now() - startedAt).toBeLessThan(1_000);
});
