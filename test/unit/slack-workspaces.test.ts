import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProntoSlack, type SlackBridge } from "../../packages/slack/src/index";
import { addTagToApps, createConfig, loadConfig, saveConfig, tagAssignments, removeTagFromApps, setTagRuntimes } from "../../packages/cli/src/config";
import { isChannelKind, type SlackChannelKind } from "../../packages/cli/src/channels/types";
import { SlackChannel, slackActivation } from "../../packages/cli/src/slack/channel";
import { chatKeyForAddress } from "../../packages/cli/src/storage/chat-key";
import { openProntoDatabase } from "../../packages/cli/src/storage/database";
import { DeliveryJournal } from "../../packages/cli/src/storage/journal";
import { parseAppFlags } from "../../packages/cli/src/tag-apps";
import { loadExistingSetupDefaults } from "../../packages/cli/src/macos/setup";
import { pathsForHome } from "../../packages/cli/src/macos/paths";

const directories: string[] = [];
const now = 1_792_152_000_000;
const referenceKey = "synthetic-workspace-reference-key-32-characters";
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

function bridge() {
  let team = "TONE";
  const calls: Array<{ operation: string; input: any }> = [];
  const overrides = new Map<string, (input: any) => any>();
  const transport: SlackBridge = {
    async request(operation, input = {}) {
      calls.push({ operation, input });
      if (overrides.has(operation)) return overrides.get(operation)!(input);
      if (operation === "discover") return { workspaces: ["TONE", "TTWO"].map((team) => ({ team, label: team === "TONE" ? "Workspace One" : "Workspace Two", profile: "direct" })) };
      if (operation === "connect") { team = String(input.team); return { team, owner: `U${team}`, label: team === "TONE" ? "Workspace One" : "Workspace Two", memberLabel: "Synthetic owner" }; }
      if (operation === "list") return { conversations: ["DSELF", "CDISCUSSION"].map((id) => ({ id, label: id, type: id.startsWith("D") ? "self" : "channel", supported: true })), nextCursor: "" };
      if (operation === "info") return { id: input.conversation, label: "Synthetic conversation", type: "channel", supported: input.conversation !== "CEXTERNAL" };
      if (operation === "history") return { messages: [{ conversation: input.conversation, user: `U${team}`, ts: "1700000000.000001", text: "Earlier owner participation" }], nextCursor: "" };
      return { messages: [], nextCursor: "", outcome: "confirmed", ts: "1792152001.000001" };
    },
    listen() { return () => {}; }, async close() {},
  };
  return { transport, calls, overrides };
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "pronto-workspaces-")); directories.push(directory);
  const rootBridge = bridge();
  const root = createProntoSlack({ directory, referenceKey, bridge: rootBridge.transport, now: () => now });
  await root.link((await root.discover()).workspaces[0]!.handle); await root.useParticipatedConversations();
  const choices = (await root.discover()).workspaces;
  const secondDirectory = join(directory, "workspaces", choices[1]!.id);
  const result = await root.linkWorkspace(choices[1]!.handle, secondDirectory);
  const secondBridge = bridge();
  const second = createProntoSlack({ directory: secondDirectory, referenceKey, bridge: secondBridge.transport, now: () => now });
  return { directory, root, rootBridge, second, secondBridge, result, choices };
}

test("adding another workspace preserves the first binding and isolates scopes, sends, and memory", async () => {
  const f = await fixture();
  try {
    expect((await f.root.connection())?.label).toBe("Workspace One");
    expect((await f.second.connection())?.label).toBe("Workspace Two");
    await f.root.qualify(); await f.second.qualify();
    const one = await f.root.observe({ conversation: "DSELF", ts: "1792152000.000001", user: "UTONE", text: "@one request" }, "live");
    const two = await f.second.observe({ conversation: "DSELF", ts: "1792152000.000001", user: "UTTWO", text: "@two request" }, "live");
    expect(one).not.toBeNull(); expect(two).not.toBeNull();
    expect(one!.scope.id).not.toBe(two!.scope.id);
    expect(await f.second.authorized(one!.scope)).toBeFalse();
    expect(await f.second.reply(one!.scope, "Wrong workspace")).toEqual({ disposition: "failed", retrySafe: false });
    expect(f.secondBridge.calls.some((call) => call.operation === "send")).toBeFalse();
    const kind: SlackChannelKind = `slack:${f.result.id}`;
    const first = slackActivation(one!, ["@one"])!;
    const second = slackActivation(two!, ["@two"], kind)!;
    expect(first.chat.channel).toBe("slack"); expect(second.chat.channel).toBe(kind);
    expect(slackActivation(two!, ["@one"], kind)).toBeNull();
    expect(chatKeyForAddress(first.chat, referenceKey)).not.toBe(chatKeyForAddress(second.chat, referenceKey));
    const channel = new SlackChannel(f.second, undefined, kind);
    await expect(channel.sendText(first.chat, "Wrong workspace", one!.scope)).rejects.toThrow("slack-scope-unavailable");
    const db = openProntoDatabase(join(f.directory, "journal.sqlite"));
    try {
      const journal = new DeliveryJournal(db);
      journal.enableMultiApp();
      journal.admit({ ...second, chatKey: chatKeyForAddress(second.chat, referenceKey) });
      expect(journal.nextRunnable()?.chat.channel).toBe(kind);
    } finally { db.close(); }
    await f.second.unlink();
    expect(await f.root.authorized(one!.scope)).toBeTrue();
    expect(await f.second.authorized(two!.scope)).toBeFalse();
  } finally { await f.root.close(); await f.second.close(); }
});

test("workspace coverage learns participation, ignores historical requests, and admits new conversations without a picker", async () => {
  const f = await fixture();
  try {
    expect((await f.second.qualify()).degraded).toEqual([]);
    expect((await f.second.connection())?.coverage).toBe("participated");
    const request = { conversation: "CDISCUSSION", ts: "1792152000.000002", user: "UPARTICIPANT", text: "@two request" };
    expect(await f.second.observe(request, "live")).toBeNull();
    const observed: unknown[] = [];
    await f.second.reconcile(async (event) => { observed.push(event); });
    expect(observed).toEqual([]); // Old owner messages establish eligibility, not new requests.
    expect(await f.second.observe(request, "live")).not.toBeNull();
    expect(await f.second.observe({ ...request, conversation: "CNEW", user: "UTTWO" }, "live")).not.toBeNull();
    expect(await f.second.observe({ ...request, conversation: "CEXTERNAL", user: "UTTWO" }, "live")).toBeNull();
    expect(f.secondBridge.calls.some((call) => call.operation === "select" && call.input.observeUnselected === true)).toBeTrue();
  } finally { await f.root.close(); await f.second.close(); }
});

test("workspace apps keep independent tags and switches across configuration reloads", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pronto-workspace-config-")); directories.push(directory);
  const kind: SlackChannelKind = `slack:${"a".repeat(32)}`;
  const config = createConfig({
    channels: { slack: { enabled: true, tags: ["@one"], riskConsentVersion: 1, workspaceLabel: "One" },
      [kind]: { enabled: false, tags: ["@two"], riskConsentVersion: 1, workspaceLabel: "Two", workspaceKey: "a".repeat(32) } },
    primaryRuntime: "codex", workingDirectory: directory, unrestrictedTrustVersion: 1,
  });
  const changed = addTagToApps(config, "@new", [kind]);
  await saveConfig(join(directory, "config.json"), changed);
  expect(await loadConfig(join(directory, "config.json"))).toEqual(changed);
  expect((await loadExistingSetupDefaults(join(directory, "config.json")))?.slackWorkspaces).toEqual(changed.channels);
  expect(changed.channels.slack?.tags).toEqual(["@one"]);
  expect(changed.channels[kind]?.tags).toEqual(["@two", "@new"]);
  expect(changed.channels[kind]?.enabled).toBeFalse();
  expect(tagAssignments(changed).find((entry) => entry.tag === "@new")?.apps).toEqual([kind]);
  expect(parseAppFlags(["--app", kind]).apps).toEqual([kind]);
  expect(isChannelKind("slack:../../another-directory")).toBeFalse();
});

test("participation in an old thread authorizes fresh replies without replaying old tags", async () => {
  const f = await fixture();
  try {
    await f.second.qualify();
    f.secondBridge.overrides.set("history", (input) => ({ messages: input.conversation === "CDISCUSSION" ? [{ conversation: input.conversation, user: "UPARTICIPANT", ts: "1700000000.000001", text: "old root", reply_count: 2, latest_reply: "1792152000.000002" }] : [], nextCursor: "" }));
    f.secondBridge.overrides.set("replies", () => ({ messages: [
      { conversation: "CDISCUSSION", user: "UTTWO", ts: "1700000000.000002", text: "@two old owner reply" },
      { conversation: "CDISCUSSION", user: "UPARTICIPANT", ts: "1792152000.000002", text: "@two new request" },
    ], nextCursor: "" }));
    const observations: any[] = [];
    await f.second.reconcile(async (event) => { observations.push(event); });
    expect(observations).toHaveLength(1);
    expect(observations[0].message.text).toBe("@two new request");
  } finally { await f.root.close(); await f.second.close(); }
});

test("workspace recovery keeps its request bound and continues at another conversation next time", async () => {
  const f = await fixture();
  try {
    f.secondBridge.overrides.set("list", () => ({ conversations: Array.from({ length: 60 }, (_, n) => ({ id: `C${n}`, label: `Synthetic ${n}`, type: "channel", supported: true })), nextCursor: "" }));
    f.secondBridge.overrides.set("history", () => ({ messages: [], nextCursor: "" }));
    await f.second.qualify();
    const first = await f.second.reconcile(async () => {});
    expect(first.status).toBe("degraded"); expect(first.requests).toBe(100);
    f.secondBridge.calls.length = 0;
    await f.second.reconcile(async () => {});
    expect(f.secondBridge.calls.find((call) => call.operation === "info")?.input.conversation).toBe("C50");
  } finally { await f.root.close(); await f.second.close(); }
});

test("a failing observation does not starve recovery of other conversations", async () => {
  const f = await fixture();
  try {
    await f.second.qualify();
    f.secondBridge.overrides.set("history", (input) => ({ messages: [{
      conversation: input.conversation, user: "UTTWO", ts: "1792152000.000001", text: "@two new request",
    }], nextCursor: "" }));
    const first = await f.second.reconcile(async () => { throw new Error("admission unavailable"); });
    expect(first.status).toBe("degraded");
    f.secondBridge.calls.length = 0;
    await f.second.reconcile(async () => {});
    expect(f.secondBridge.calls.find((call) => call.operation === "info")?.input.conversation).toBe("CDISCUSSION");
  } finally { await f.root.close(); await f.second.close(); }
});

test("the CLI lists workspace apps and edits tags while a workspace is off", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pronto-workspace-cli-")); directories.push(directory);
  const kind: SlackChannelKind = `slack:${"b".repeat(32)}`;
  const path = pathsForHome(directory).configPath;
  await saveConfig(path, createConfig({
    channels: { slack: { enabled: true, tags: ["@one"], riskConsentVersion: 1, workspaceLabel: "One" },
      [kind]: { enabled: false, tags: ["@two"], riskConsentVersion: 1, workspaceLabel: "Two", workspaceKey: "b".repeat(32) } },
    primaryRuntime: "codex", workingDirectory: directory, unrestrictedTrustVersion: 1,
  }));
  const run = async (args: string[]) => {
    const child = Bun.spawn([process.execPath, "packages/cli/src/cli.ts", ...args, "--json"], {
      cwd: join(import.meta.dir, "../.."), env: { ...process.env, HOME: directory }, stdout: "pipe", stderr: "pipe",
    });
    const [code, output] = await Promise.all([child.exited, new Response(child.stdout).text()]);
    expect(code).toBe(0);
    return JSON.parse(output);
  };
  const listed = await run(["channels", "list"]);
  expect(listed.channels.filter((row: { app: string }) => row.app.startsWith("slack")).map((row: { label: string }) => row.label)).toEqual(["One", "Two"]);
  await run(["tags", "add", "@new", "--app", kind]);
  const edited = await loadConfig(path);
  expect(edited.channels[kind]?.tags).toEqual(["@two", "@new"]);
  expect(edited.channels[kind]?.enabled).toBeFalse();
  expect(edited.channels.slack?.tags).toEqual(["@one"]);
  await run(["channels", "enable", kind]);
  expect((await loadConfig(path)).channels[kind]?.enabled).toBeTrue();
});

test("a Slack workspace can wait for a centrally assigned tag and return to having none", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pronto-workspace-empty-tags-")); directories.push(directory);
  const config = createConfig({ channels: { slack: { enabled: true, tags: [], riskConsentVersion: 1, workspaceLabel: "One" } },
    primaryRuntime: "codex", workingDirectory: directory, unrestrictedTrustVersion: 1 });
  await saveConfig(join(directory, "config.json"), config);
  expect((await loadConfig(join(directory, "config.json"))).channels.slack?.tags).toEqual([]);
  expect(tagAssignments(config)).toEqual([]);
  const tagged = setTagRuntimes(addTagToApps(config, "@central", ["slack"]), "@central", { primaryRuntime: "codex" });
  const removed = removeTagFromApps(tagged, "@central", ["slack"]);
  expect(removed.channels.slack?.tags).toEqual([]);
  expect(removed.tagRuntimes?.["@central"]).toBeUndefined();
  expect(() => createConfig({ ...config, channels: { imessage: { enabled: true, tags: [], imsgPath: "/synthetic/imsg" } } })).toThrow("at least one tag");
});
