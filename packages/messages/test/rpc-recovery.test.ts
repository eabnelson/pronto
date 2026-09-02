import { expect, test } from "bun:test";
import {
  ResilientRpcClient,
  type RpcConnection,
  type RpcNotification,
} from "../src/internal/rpc";

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
