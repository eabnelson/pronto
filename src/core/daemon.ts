import type { S4imsgConfig } from "../config";
import { ImsgCurrentChatSource } from "../imessage/current-chat-source";
import { NdjsonRpcClient } from "../imessage/rpc-client";
import { ImsgTransport } from "../imessage/transport";
import type { S4imsgPaths } from "../macos/paths";
import { ClaudeAdapter } from "../runtimes/claude";
import { CodexAdapter } from "../runtimes/codex";
import { RuntimeChain } from "../runtimes/chain";
import type { RuntimeAdapter } from "../runtimes/types";
import { openS4imsgDatabase } from "../storage/database";
import { DeliveryJournal } from "../storage/journal";
import { MemoryStore } from "../storage/memory";
import { ConversationBroker } from "../tools/broker";
import { TurnCoordinator, TurnProcessor } from "./turn";

function adapter(kind: "codex" | "claude", path: string): RuntimeAdapter {
  return kind === "codex" ? new CodexAdapter(path) : new ClaudeAdapter(path);
}

function runtimePath(config: S4imsgConfig, fallback = false): string {
  const path = fallback ? config.fallbackRuntimePath : config.primaryRuntimePath;
  if (path === undefined) throw new Error("Runtime executable path is missing; run s4imsg setup");
  return path;
}

export class S4imsgDaemon {
  #stopRequested = false;
  #stop: (() => void) | null = null;

  constructor(
    readonly config: S4imsgConfig,
    readonly paths: S4imsgPaths,
  ) {}

  stop(): void {
    this.#stopRequested = true;
    this.#stop?.();
  }

  async run(): Promise<void> {
    const database = openS4imsgDatabase(this.paths.databasePath);
    const journal = new DeliveryJournal(database);
    const rpc = new NdjsonRpcClient(this.config.imsgPath);
    const transport = new ImsgTransport(rpc, {
      matches: (chatId, text) => journal.matchesOutboundEcho(chatId, text),
    });
    const broker = new ConversationBroker(new ImsgCurrentChatSource(rpc));
    let brokerServer: ReturnType<ConversationBroker["listen"]> | null = null;
    let activeWatch: Awaited<ReturnType<ImsgTransport["watch"]>> | null = null;

    try {
      const qualification = await transport.qualify();
      brokerServer = broker.listen();
      const primary = adapter(this.config.primaryRuntime, runtimePath(this.config));
      const fallback =
        this.config.fallbackRuntime === undefined
          ? undefined
          : adapter(this.config.fallbackRuntime, runtimePath(this.config, true));
      const memory = new MemoryStore(database);
      const coordinator = new TurnCoordinator(
        new TurnProcessor({
          bridgeExecutablePath: this.paths.executablePath,
          broker,
          brokerUrl: brokerServer.url,
          journal,
          memory,
          runtimes: new RuntimeChain(primary, fallback),
          transport,
          workingDirectory: this.config.workingDirectory,
        }),
        journal,
        this.config.chatKeySalt,
      );
      const recovered = coordinator.start();
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
          tag: this.config.tag,
        });
        const outcome = await Promise.race([stopSignal, overflowSignal]);
        await activeWatch.close();
        activeWatch = null;
        if (outcome === "stop") break;
        const cursor = await transport.catchUp({
          onActivation: (request) => {
            coordinator.admit(request);
          },
          onMessageRowId: (rowId) => journal.advanceCursor(rowId),
          sinceRowId: outcome,
          tag: this.config.tag,
        });
        journal.advanceCursor(cursor);
      }
      await coordinator.idle();
    } finally {
      this.#stop = null;
      await activeWatch?.close().catch(() => undefined);
      brokerServer?.close();
      await rpc.close().catch(() => undefined);
      database.close();
    }
  }
}
