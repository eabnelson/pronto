import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createConfig } from "../../packages/cli/src/config";
import { ProntoDaemon } from "../../packages/cli/src/core/daemon";
import { pathsForHome } from "../../packages/cli/src/macos/paths";
import { openProntoDatabase } from "../../packages/cli/src/storage/database";
import { DeliveryJournal } from "../../packages/cli/src/storage/journal";
import { createProntoMessages } from "pronto-imessage";

test.each([false, true])("restart waits for subscription and preserves recovery degradation (%s)", async (degraded) => {
  const directory = await mkdtemp(join(tmpdir(), "pronto-readiness-"));
  const paths = pathsForHome(directory);
  const provider = join(directory, "imsg-fixture");
  const providerDatabase = join(directory, "chat.db");
  const subscribing = join(directory, "subscribing");
  const release = join(directory, "release");
  await writeFile(providerDatabase, "synthetic database identity");
  await writeFile(provider, `#!/usr/bin/env bun
    import { writeFileSync, existsSync } from "node:fs";
    let buffer = "";
    for await (const chunk of Bun.stdin.stream()) {
      buffer += new TextDecoder().decode(chunk);
      while (buffer.includes("\\n")) {
        const end = buffer.indexOf("\\n");
        const request = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        let result = { ok: true };
        if (request.method === "initialize") result = {
          protocol_version: 1, version: "0.14.1",
          database: { path: ${JSON.stringify(providerDatabase)}, ready: true, features: { routing_metadata: true } },
          methods: ["initialize", "status", "chats.list", "messages.history", "messages.after", "messages.stats", "watch.subscribe", "watch.unsubscribe", "send"],
        };
        if (request.method === "watch.subscribe") {
          writeFileSync(${JSON.stringify(subscribing)}, "started");
          while (!existsSync(${JSON.stringify(release)})) await Bun.sleep(5);
          result = { subscription: 1 };
        }
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");
      }
    }
  `, { mode: 0o700 });
  const database = openProntoDatabase(paths.databasePath);
  const journal = new DeliveryJournal(database);
  journal.recordDaemonHealth("ready"); // Prior process's persisted status.
  if (degraded) {
    const messages = createProntoMessages({ imsgPath: provider, statePath: paths.providerStatePath });
    try {
      const qualified = await messages.qualify();
      await messages.adoptCheckpoint!({ version: 1, rowId: 0, databaseGeneration: qualified.databaseGeneration });
    } finally { await messages.close(); }
  }
  const daemon = new ProntoDaemon(createConfig({
    channels: { imessage: { enabled: true, imsgPath: provider, tags: ["@test"] } },
    primaryRuntime: "codex", primaryRuntimePath: process.execPath,
    unrestrictedTrustVersion: 1, workingDirectory: directory,
  }), paths);
  const running = daemon.run();
  try {
    const deadline = Date.now() + 2_000;
    while (!await Bun.file(subscribing).exists() && Date.now() < deadline) await Bun.sleep(5);
    expect(await Bun.file(subscribing).exists()).toBe(true);
    expect(journal.daemonHealth()?.state).not.toBe("ready");
    await writeFile(release, "continue");
    const expected = degraded ? "degraded" : "ready";
    const readyDeadline = Date.now() + 2_000;
    while (journal.daemonHealth()?.state !== expected && Date.now() < readyDeadline) await Bun.sleep(5);
    expect(journal.daemonHealth()?.state).toBe(expected);
    if (degraded) expect(journal.degradedCapabilities()).toContain("messages-recovery-invalid-provider-page");
  } finally {
    await writeFile(release, "continue");
    daemon.stop();
    await running;
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a broken WhatsApp install degrades only WhatsApp while iMessage serves", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pronto-isolation-"));
  const paths = pathsForHome(directory);
  const provider = join(directory, "imsg-fixture");
  const wacli = join(directory, "wacli-fixture");
  const providerDatabase = join(directory, "chat.db");
  await writeFile(providerDatabase, "synthetic database identity");
  await writeFile(provider, `#!/usr/bin/env bun
    let buffer = "";
    for await (const chunk of Bun.stdin.stream()) {
      buffer += new TextDecoder().decode(chunk);
      while (buffer.includes("\\n")) {
        const end = buffer.indexOf("\\n");
        const request = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        let result = { ok: true };
        if (request.method === "initialize") result = {
          protocol_version: 1, version: "0.14.1",
          database: { path: ${JSON.stringify(providerDatabase)}, ready: true, features: { routing_metadata: true } },
          methods: ["initialize", "status", "chats.list", "messages.history", "messages.after", "messages.stats", "watch.subscribe", "watch.unsubscribe", "send"],
        };
        if (request.method === "watch.subscribe") result = { subscription: 1 };
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");
      }
    }
  `, { mode: 0o700 });
  await writeFile(wacli, "#!/bin/sh\necho 'wacli fixture is broken' >&2\nexit 1\n", { mode: 0o700 });
  const daemon = new ProntoDaemon(createConfig({
    channels: {
      imessage: { enabled: true, imsgPath: provider, tags: ["@test"] },
      whatsapp: { enabled: true, riskConsentVersion: 1, tags: ["@test"], wacliPath: wacli },
    },
    primaryRuntime: "codex", primaryRuntimePath: process.execPath,
    unrestrictedTrustVersion: 1, workingDirectory: directory,
  }), paths);
  const running = daemon.run();
  const database = openProntoDatabase(paths.databasePath);
  const journal = new DeliveryJournal(database);
  try {
    const deadline = Date.now() + 5_000;
    while (journal.channelHealth().imessage?.state !== "ready" && Date.now() < deadline) {
      await Bun.sleep(10);
    }
    expect(journal.channelHealth()).toMatchObject({
      imessage: { state: "ready" },
      whatsapp: { reason: "qualification-failed", state: "failed" },
    });
    expect(journal.daemonHealth()?.state).toBe("degraded");
    expect(journal.degradedCapabilities()).toContain("whatsapp-unavailable");
    expect(database.query("PRAGMA user_version").get()).toEqual({ user_version: 6 });
  } finally {
    daemon.stop();
    await running;
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("reload turns WhatsApp on and off while iMessage keeps serving", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pronto-reload-"));
  const paths = pathsForHome(directory);
  const provider = join(directory, "imsg-fixture");
  const wacli = join(directory, "wacli-fixture");
  const providerDatabase = join(directory, "chat.db");
  await writeFile(providerDatabase, "synthetic database identity");
  await writeFile(provider, `#!/usr/bin/env bun
    let buffer = "";
    for await (const chunk of Bun.stdin.stream()) {
      buffer += new TextDecoder().decode(chunk);
      while (buffer.includes("\\n")) {
        const end = buffer.indexOf("\\n");
        const request = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        let result = { ok: true };
        if (request.method === "initialize") result = {
          protocol_version: 1, version: "0.14.1",
          database: { path: ${JSON.stringify(providerDatabase)}, ready: true, features: { routing_metadata: true } },
          methods: ["initialize", "status", "chats.list", "messages.history", "messages.after", "messages.stats", "watch.subscribe", "watch.unsubscribe", "send"],
        };
        if (request.method === "watch.subscribe") result = { subscription: 1 };
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");
      }
    }
  `, { mode: 0o700 });
  await writeFile(wacli, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
  const base = {
    primaryRuntime: "codex" as const, primaryRuntimePath: process.execPath,
    unrestrictedTrustVersion: 1 as const, workingDirectory: directory,
  };
  const imessageOnly = createConfig({
    ...base,
    channels: { imessage: { enabled: true, imsgPath: provider, tags: ["@test"] } },
  });
  const withWhatsapp = createConfig({
    ...base,
    channels: {
      imessage: { enabled: true, imsgPath: provider, tags: ["@test"] },
      whatsapp: { enabled: true, riskConsentVersion: 1, tags: ["@test"], wacliPath: wacli },
    },
    chatKeySalt: imessageOnly.chatKeySalt,
  });
  const daemon = new ProntoDaemon(imessageOnly, paths);
  const running = daemon.run();
  const database = openProntoDatabase(paths.databasePath);
  const journal = new DeliveryJournal(database);
  const waitFor = async (probe: () => boolean) => {
    const deadline = Date.now() + 5_000;
    while (!probe() && Date.now() < deadline) await Bun.sleep(10);
  };
  try {
    await waitFor(() => journal.daemonHealth()?.state === "ready");
    expect(journal.channelHealth().whatsapp).toBeUndefined();

    await daemon.reload(async () => withWhatsapp);
    expect(journal.channelHealth()).toMatchObject({
      imessage: { state: "ready" },
      whatsapp: { reason: "qualification-failed", state: "failed" },
    });
    expect(journal.daemonHealth()?.state).toBe("degraded");
    expect(database.query("PRAGMA user_version").get()).toEqual({ user_version: 6 });

    await daemon.reload(async () => imessageOnly);
    expect(journal.channelHealth()).toMatchObject({
      imessage: { state: "ready" },
      whatsapp: { state: "stopped" },
    });
    expect(journal.daemonHealth()?.state).toBe("ready");
    expect(daemon.config.channels.whatsapp).toBeUndefined();
  } finally {
    daemon.stop();
    await running;
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

