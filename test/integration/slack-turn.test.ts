import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createProntoSlack, type SlackBridge } from "../../packages/slack/src/index";
import { SlackChannel, slackActivation } from "../../packages/cli/src/slack/channel";
import { TurnCoordinator, TurnProcessor } from "../../packages/cli/src/core/turn";
import { openProntoDatabase } from "../../packages/cli/src/storage/database";
import { DeliveryJournal } from "../../packages/cli/src/storage/journal";
import { MemoryStore } from "../../packages/cli/src/storage/memory";
import { WorkspaceStore } from "../../packages/cli/src/storage/workspaces";
import { chatKeyForAddress } from "../../packages/cli/src/storage/chat-key";
import { ConversationBroker } from "../../packages/cli/src/tools/broker";
import { RuntimeChain } from "../../packages/cli/src/runtimes/chain";
import type { RuntimeAdapter } from "../../packages/cli/src/runtimes/types";

for (const outcome of ["confirmed", "ambiguous", "revoked", "revoked-after-send"] as const) test(`Slack real coordinator persists scopes and handles ${outcome} delivery`, async () => {
  const directory = await mkdtemp(join(tmpdir(), "pronto-slack-turn-"));
  const salt = "synthetic-installation-salt-32-characters";
  const sends: any[] = []; const prompts: string[] = [];
  const bridge: SlackBridge = {
    async request(operation, input = {}) {
      if (operation === "discover") return { workspaces: [{ team: "TFIXTURE", label: "Synthetic workspace", profile: "direct" }] };
      if (operation === "connect") return { team: "TFIXTURE", owner: "UFIXTURE", label: "Synthetic workspace", memberLabel: "Synthetic owner" };
      if (operation === "list") return { conversations: [{ id: "CFIXTURE", label: "Synthetic channel", type: "channel", supported: true }], nextCursor: "" };
      if (operation === "info") return { id: "CFIXTURE", label: "Synthetic channel", type: "channel", supported: true };
      if (operation === "send") { sends.push(input); return { outcome: outcome === "ambiguous" ? "ambiguous" : "confirmed", ts: "1792152000.000003" }; }
      return { messages: [{ conversation: "CFIXTURE", ts: "1792152000.000001", user: "UFIXTURE", text: "Synthetic root context" }], nextCursor: "" };
    }, listen() { return () => {}; }, async close() {},
  };
  const provider = createProntoSlack({ directory: join(directory, "provider"), referenceKey: salt, bridge, now: () => 1_792_152_000_000 });
  const db = openProntoDatabase(join(directory, "state.sqlite"));
  try {
    await provider.link((await provider.discover()).workspaces[0]!.handle);
    await provider.select([(await provider.conversations()).conversations[0]!.handle]);
    const observed = await provider.observe({ conversation: "CFIXTURE", ts: "1792152000.000001", user: "UFIXTURE", text: "@pronto synthetic request" }, "live");
    const activation = slackActivation(observed!, ["@pronto"])!;
    const channel = new SlackChannel(provider);
    if (outcome === "revoked-after-send") channel.canCommit = async () => { await provider.select([]); return false; };
    const journal = new DeliveryJournal(db); journal.enableMultiApp();
    const memory = new MemoryStore(db); const workspaces = new WorkspaceStore(db);
    const runtime: RuntimeAdapter = { kind: "codex", executablePath: "/synthetic/codex", async run(input) {
      prompts.push(input.prompt);
      if (outcome === "revoked") await provider.select([]);
      return { status: "success", toolActivity: "none", output: { reply: "Synthetic answer", attachmentPath: "/synthetic/unsupported-file.txt" } };
    } };
    const coordinator = new TurnCoordinator(new TurnProcessor({ bridgeExecutablePath: "/synthetic/pronto", broker: new ConversationBroker(channel.currentChat), brokerUrl: "http://127.0.0.1:1", channels: new Map([["slack", channel]]), journal, memory, workspaces, defaultWorkingDirectory: directory, runtimes: new RuntimeChain(runtime) }), journal, salt);
    coordinator.start();
    expect(coordinator.admit(activation)).toBe("accepted");
    await coordinator.idle();
    expect(coordinator.admit(activation)).toBe("duplicate");
    expect(prompts[0]).toContain("Synthetic root context");
    const key = chatKeyForAddress(activation.chat, salt);
    expect(memory.get(key).exchanges).toHaveLength(outcome === "confirmed" ? 1 : 0);
    expect(sends).toHaveLength(outcome === "revoked" ? 0 : 1);
    if (sends[0]) { expect(sends[0].thread).toBe("1792152000.000001"); expect(sends[0].text).toContain("no file was uploaded"); }
    expect(journal.state(activation.providerGuid)).toBe(outcome === "confirmed" || outcome === "revoked-after-send" ? "delivered" : outcome === "ambiguous" ? "ambiguous" : "failed");
    coordinator.start();
    await coordinator.idle();
    expect(sends).toHaveLength(outcome === "revoked" ? 0 : 1);
  } finally { db.close(); await provider.close(); await rm(directory, { force: true, recursive: true }); }
});
