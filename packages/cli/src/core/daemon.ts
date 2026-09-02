import type { ProntoConfig } from "../config";
import { ImsgCurrentChatSource } from "../imessage/current-chat-source";
import { NdjsonRpcClient } from "../imessage/rpc-client";
import { ImsgTransport } from "../imessage/transport";
import type { ProntoPaths } from "../macos/paths";
import { RuntimeChain } from "../runtimes/chain";
import { createRuntimeAdapter } from "../runtimes/factory";
import { openProntoDatabase } from "../storage/database";
import { DeliveryJournal } from "../storage/journal";
import { MemoryStore } from "../storage/memory";
import { WorkspaceStore } from "../storage/workspaces";
import { ConversationBroker } from "../tools/broker";
import { TurnCoordinator, TurnProcessor } from "./turn";
import { createProntoMessages } from "pronto-imessage";

function runtimePath(config: ProntoConfig, fallback = false): string {
  const path = fallback ? config.fallbackRuntimePath : config.primaryRuntimePath;
  if (path === undefined) throw new Error("Runtime executable path is missing; run pronto setup");
  return path;
}

export class ProntoDaemon {
  #stopRequested = false;
  #stop: (() => void) | null = null;

  constructor(
    readonly config: ProntoConfig,
    readonly paths: ProntoPaths,
  ) {}

  stop(): void {
    this.#stopRequested = true;
    this.#stop?.();
  }

  async run(): Promise<void> {
    const database = openProntoDatabase(this.paths.databasePath);
    const journal = new DeliveryJournal(database);
    const rpc = new NdjsonRpcClient(this.config.imsgPath);
    const messages = createProntoMessages({ imsgPath: this.config.imsgPath });
    const transport = new ImsgTransport(rpc, {
      matchesOutboundEcho: (chatId, text) => journal.matchesOutboundEcho(chatId, text),
      messages,
    });
    const broker = new ConversationBroker(new ImsgCurrentChatSource(rpc));
    let brokerServer: ReturnType<ConversationBroker["listen"]> | null = null;
    let activeWatch: Awaited<ReturnType<ImsgTransport["watch"]>> | null = null;

    try {
      const qualification = await transport.qualify();
      brokerServer = broker.listen();
      const primary = createRuntimeAdapter(this.config.primaryRuntime, runtimePath(this.config));
      const fallback =
        this.config.fallbackRuntime === undefined
          ? undefined
          : createRuntimeAdapter(this.config.fallbackRuntime, runtimePath(this.config, true));
      const memory = new MemoryStore(database);
      const workspaces = new WorkspaceStore(database);
      const coordinator = new TurnCoordinator(
        new TurnProcessor({
          bridgeExecutablePath: this.paths.executablePath,
          broker,
          brokerUrl: brokerServer.url,
          journal,
          memory,
          runtimes: new RuntimeChain(primary, fallback),
          transport,
          defaultWorkingDirectory: this.config.workingDirectory,
          workspaces,
        }),
        journal,
        this.config.chatKeySalt,
      );
      const recovered = coordinator.start();
      journal.recordDegradedCapabilities(qualification.degraded);
      journal.recordDaemonHealth("ready");
      console.log(
        JSON.stringify({
          component: "daemon",
          degradedCapabilities: qualification.degraded,
          recovery: recovered,
          state: "ready",
        }),
      );

      let stopped = false;
      const stopSignal = new Promise<"stop">((resolve) => {
        this.#stop = () => {
          stopped = true;
          resolve("stop");
        };
        if (this.#stopRequested) this.#stop();
      });

      while (!stopped) {
        let overflow: ((cursor: number) => void) | null = null;
        const overflowSignal = new Promise<number>((resolve) => {
          overflow = resolve;
        });
        const sinceRowId = journal.cursor();
        activeWatch = await transport.watch({
          onActivation: (request) => {
            coordinator.admit(request);
          },
          onMessageRowId: (rowId) => journal.advanceCursor(rowId),
          onOverflow: (cursor) => overflow?.(cursor),
          ...(sinceRowId === undefined ? {} : { sinceRowId }),
          tags: this.config.tags,
        });
        const outcome = await Promise.race([
          stopSignal,
          overflowSignal,
          activeWatch.terminated.then(() => "transport-closed" as const),
        ]);
        await activeWatch.close().catch(() => undefined);
        activeWatch = null;
        if (outcome === "stop") break;
        if (outcome === "transport-closed") throw new Error("imsg RPC transport closed");
        const cursor = await transport.catchUp({
          onActivation: (request) => {
            coordinator.admit(request);
          },
          onMessageRowId: (rowId) => journal.advanceCursor(rowId),
          sinceRowId: outcome,
          tags: this.config.tags,
        });
        journal.advanceCursor(cursor);
      }
      await coordinator.idle();
      journal.recordDaemonHealth("stopped");
    } catch (error) {
      journal.recordDaemonHealth("failed");
      throw error;
    } finally {
      this.#stop = null;
      await activeWatch?.close().catch(() => undefined);
      brokerServer?.close();
      await rpc.close().catch(() => undefined);
      await messages.close().catch(() => undefined);
      database.close();
    }
  }
}
