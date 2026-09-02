import type { ProntoConfig } from "../config";
import { ImsgCurrentChatSource } from "../imessage/current-chat-source";
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
import {
  createProntoMessages,
  type CreateProntoMessagesOptions,
} from "pronto-imessage";

export const STANDALONE_SCOPE_TTL_MS = 24 * 60 * 60 * 1_000;

export function standaloneMessagesOptions(input: {
  readonly chatKeySalt: string;
  readonly imsgPath: string;
  readonly legacyUnscopedCursor?: number;
  readonly providerStatePath: string;
}): CreateProntoMessagesOptions {
  return {
    imsgPath: input.imsgPath,
    ...(input.legacyUnscopedCursor === undefined
      ? {}
      : { legacyUnscopedCursor: input.legacyUnscopedCursor }),
    referenceKey: input.chatKeySalt,
    scopeLimits: { ttlMs: STANDALONE_SCOPE_TTL_MS },
    statePath: input.providerStatePath,
  };
}

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
    const legacyUnscopedCursor = journal.cursor();
    const messages = createProntoMessages(standaloneMessagesOptions({
      chatKeySalt: this.config.chatKeySalt,
      imsgPath: this.config.imsgPath,
      ...(legacyUnscopedCursor === undefined ? {} : { legacyUnscopedCursor }),
      providerStatePath: this.paths.providerStatePath,
    }));
    const transport = new ImsgTransport(messages, {
      matchesOutboundEcho: (chatId, text) => journal.matchesOutboundEcho(chatId, text),
    });
    const currentChatSource = new ImsgCurrentChatSource(
      messages,
      (chatId) => transport.conversationContext(chatId),
    );
    const broker = new ConversationBroker(currentChatSource);
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

      const stopSignal = new Promise<"stop">((resolve) => {
        this.#stop = () => {
          resolve("stop");
        };
        if (this.#stopRequested) this.#stop();
      });
      activeWatch = await transport.watch({
        onActivation: (request) => {
          coordinator.admit(request);
        },
        onMessageRowId: (rowId) => journal.advanceCursor(rowId),
        tags: this.config.tags,
      });
      const outcome = await Promise.race([
        stopSignal,
        activeWatch.terminated.then(() => "transport-closed" as const),
      ]);
      if (outcome === "transport-closed") throw new Error("Pronto Messages transport closed");
      await activeWatch.close().catch(() => undefined);
      activeWatch = null;
      await coordinator.idle();
      journal.recordDaemonHealth("stopped");
    } catch (error) {
      journal.recordDaemonHealth("failed");
      throw error;
    } finally {
      this.#stop = null;
      await activeWatch?.close().catch(() => undefined);
      brokerServer?.close();
      await currentChatSource.close().catch(() => undefined);
      await messages.close().catch(() => undefined);
      database.close();
    }
  }
}
