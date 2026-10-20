import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfig } from "../../packages/cli/src/config";
import { ProntoDaemon } from "../../packages/cli/src/core/daemon";
import type { Channel } from "../../packages/cli/src/channels/types";
import { pathsForHome } from "../../packages/cli/src/macos/paths";
import { openProntoDatabase } from "../../packages/cli/src/storage/database";
import { DeliveryJournal } from "../../packages/cli/src/storage/journal";

test("successful Slack recovery cannot hide a disconnected live stream", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pronto-connection-health-"));
  const paths = pathsForHome(directory);
  let callbacks: Parameters<Channel["watch"]>[0] | undefined;
  let terminate!: () => void;
  const terminated = new Promise<void>((resolve) => { terminate = resolve; });
  const channel: Channel = {
    kind: "slack", conversationLabel: "Synthetic Slack",
    currentChat: { async details() { return {}; }, async history() { return {}; }, async attachment() { return null; } },
    async qualify() { return { degraded: [], version: "fixture" }; },
    async watch(input) {
      callbacks = input;
      input.onHealth?.({ state: "connected" });
      input.onRecovery?.({ status: "recovered" });
      return { async close() { terminate(); }, terminated };
    },
    formatReply(_tag, text) { return text; }, replyBodyCharacterLimit(_tag, limit) { return limit; },
    async recentMessages() { return []; }, async sendText() { return { disposition: "failed", retrySafe: false }; },
    async close() {},
  };
  const daemon = new ProntoDaemon(createConfig({
    channels: { slack: { enabled: true, riskConsentVersion: 1, tags: ["@test"] } },
    primaryRuntime: "codex", primaryRuntimePath: process.execPath,
    unrestrictedTrustVersion: 1, workingDirectory: directory,
  }), paths, () => channel);
  const database = openProntoDatabase(paths.databasePath);
  const journal = new DeliveryJournal(database);
  const running = daemon.run();
  try {
    const deadline = Date.now() + 2_000;
    while (journal.daemonHealth()?.state !== "ready" && Date.now() < deadline) await Bun.sleep(5);
    expect(journal.daemonHealth()?.state).toBe("ready");

    callbacks!.onHealth?.({ state: "reconnecting", reason: "slack-socket-disconnected" });
    callbacks!.onRecovery?.({ status: "recovered" });
    expect(journal.channelHealth().slack).toMatchObject({ state: "degraded", reason: "slack-socket-disconnected" });
    expect(journal.daemonHealth()?.state).toBe("degraded");

    callbacks!.onRecovery?.({ status: "degraded", reason: "slack-recovery-incomplete" });
    callbacks!.onHealth?.({ state: "connected" });
    expect(journal.channelHealth().slack).toMatchObject({ state: "degraded", reason: "slack-recovery-incomplete" });

    callbacks!.onRecovery?.({ status: "recovered" });
    expect(journal.channelHealth().slack?.state).toBe("ready");
    expect(journal.daemonHealth()?.state).toBe("ready");
  } finally {
    daemon.stop(); await running; database.close();
    await rm(directory, { recursive: true, force: true });
  }
});
