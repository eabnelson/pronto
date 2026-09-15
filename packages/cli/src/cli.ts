#!/usr/bin/env bun

import packageJson from "../package.json" with { type: "json" };
import { createInterface } from "node:readline/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { stdin, stdout } from "node:process";
import {
  addTag,
  loadConfig,
  normalizeConductorConfig,
  normalizeTags,
  removeTag,
  saveConfig,
  type ConductorAgentKind,
  type ConductorEffort,
  type LocalRuntimeKind,
  type ProntoConfig,
} from "./config";
import {
  launchAgentStateForLabel,
  parseLaunchAgentState,
  removeLaunchAgent,
  restoreLaunchAgentForLabel,
  restartLaunchAgent,
  stopLaunchAgent,
  stopLaunchAgentForLabel,
} from "./macos/launch-agent";
import { legacyPathsForHome, pathsForHome } from "./macos/paths";
import {
  TRUST_DISCLOSURE,
  completeSetupCutover,
  createWorkspaceDirectory,
  discoverCommands,
  fullDiskAccessInstructions,
  inspectInstallation,
  installSetup,
  loadExistingSetupDefaults,
  prepareLegacyInstallation,
  prepareSetupConfig,
  qualifyInstalledExecutable,
  resolveWorkspaceSelection,
  setupCompletionMessage,
  uninstallInstallation,
  runCommand,
} from "./macos/setup";
import { openProntoDatabase } from "./storage/database";
import { MemoryStore } from "./storage/memory";
import { brokerQuery, runMcpStdio } from "./tools/mcp";
import { ProntoDaemon } from "./core/daemon";
import { qualifyRuntime } from "./runtimes/qualification";
import { createRuntimeAdapter } from "./runtimes/factory";
import { ConductorApiClient } from "./runtimes/conductor";
import { ImsgTransport } from "./imessage/transport";
import { DeliveryJournal } from "./storage/journal";
import { ConductorBindingStore } from "./storage/conductor";
import {
  canonicalLinkedWorktree,
  WorktreeBindingStore,
} from "./storage/worktree-bindings";
import { LAUNCH_AGENT_LABEL, UPDATER_LAUNCH_AGENT_LABEL } from "./macos/paths";
import { createProntoMessages } from "pronto-imessage";
import {
  PRONTO_ATTEMPT_CAPABILITY_ENV,
  PRONTO_BROKER_URL_ENV,
} from "./tools/contract";
import { ProntoUpdater } from "./update";

const HELP = `pronto ${packageJson.version}

Usage: pronto <command>

Commands:
  setup       Configure and install the local listener
  run         Run the listener in the foreground
  status      Show listener health without conversation content
  doctor      Check local capabilities and permissions
  tags        List, add, or remove trigger tags
  worktree    Bind a chat to a local linked Git worktree
  conductor   Configure the optional Conductor Cloud tag
  update      Check for or install a verified Pronto update
  stop        Stop the installed listener
  forget      Remove one chat's tagged memory and workspace state
  uninstall   Remove the listener while preserving data by default

Options:
  -h, --help     Show this help
  -v, --version  Show the installed version`;

async function runSetup(): Promise<number> {
  if (process.platform !== "darwin") {
    console.error("Pronto setup requires macOS.");
    return 1;
  }

  const discovery = discoverCommands();
  const available = (["codex", "claude"] as const).filter(
    (runtime) => discovery.runtimes[runtime] !== undefined,
  );
  if (available.length === 0) {
    console.error("Install and authenticate Codex or Claude Code before setup.");
    return 1;
  }

  const prompt = createInterface({ input: stdin, output: stdout });
  try {
    const paths = pathsForHome(homedir());
    const legacyPaths = legacyPathsForHome(homedir());
    const existing = await loadExistingSetupDefaults(paths.configPath) ??
      await loadExistingSetupDefaults(legacyPaths.configPath);
    const defaultTags = existing?.tags ?? ["@s4"];
    const tagAnswer = (await prompt.question(
      `Trigger tags, separated by commas [${defaultTags.join(", ")}]: `,
    )).trim();
    const tags = tagAnswer === ""
      ? defaultTags
      : normalizeTags(tagAnswer.split(",").map((tag) => tag.trim()));
    const primaryAnswer =
      available.length === 1
        ? available[0]!
        : ((await prompt.question(`Primary runtime [${available.join("/")}]: `))
            .trim()
            .toLowerCase() as (typeof available)[number]);
    if (!available.includes(primaryAnswer)) throw new Error("Choose an installed runtime");
    const fallbackCandidate = available.find((runtime) => runtime !== primaryAnswer);
    const wantsFallback =
      fallbackCandidate === undefined
        ? false
        : (await prompt.question(`Use ${fallbackCandidate} as fallback? [y/N]: `))
            .trim()
            .toLowerCase() === "y";

    const defaultWorkspace = existing?.workingDirectory ?? join(homedir(), "pronto");
    let workspacePrompt = `Default working folder [${defaultWorkspace}]: `;
    let workspaceFallback = defaultWorkspace;
    let selection;
    while (true) {
      const enteredPath = (await prompt.question(workspacePrompt)).trim();
      if (enteredPath === "" && workspaceFallback === "") {
        console.error("Enter a working folder path.");
        continue;
      }
      const answer = enteredPath || workspaceFallback;
      try {
        selection = await resolveWorkspaceSelection(answer, homedir());
      } catch (error) {
        console.error((error as Error).message);
        workspacePrompt = "Choose another working folder: ";
        workspaceFallback = "";
        continue;
      }
      if (!selection.exists) break;
      const reuse = (await prompt.question(`Reuse existing folder ${selection.path}? [Y/n]: `))
        .trim()
        .toLowerCase();
      if (reuse !== "n" && reuse !== "no") break;
      workspacePrompt = "Choose another working folder: ";
      workspaceFallback = "";
    }

    console.log(`\n${TRUST_DISCLOSURE}\n`);
    const confirmed = (await prompt.question("Type yes to accept this trust model: "))
      .trim()
      .toLowerCase();
    if (confirmed !== "yes") {
      console.error("Setup cancelled without changing the service.");
      return 1;
    }

    const workingDirectory = selection.exists
      ? selection.path
      : await createWorkspaceDirectory(selection.path);
    const config = prepareSetupConfig({
      ...(existing === null ? {} : { chatKeySalt: existing.chatKeySalt }),
      ...(existing?.conductor === undefined ? {} : { conductor: existing.conductor }),
      discovery,
      ...(wantsFallback && fallbackCandidate !== undefined
        ? { fallbackRuntime: fallbackCandidate }
        : {}),
      primaryRuntime: primaryAnswer,
      tags,
      workingDirectory,
    });
    const sourceEntry = process.argv[1];
    const sourceInvocation = sourceEntry !== undefined && sourceEntry.endsWith(".ts");
    const bridgeExecutablePath = process.execPath;
    const bridgeExecutableArgs = sourceInvocation ? [resolve(sourceEntry)] : undefined;
    await completeSetupCutover({
      paths,
      install: async () => {
        await installSetup({
          config,
          paths,
          ...(sourceInvocation
            ? { repositoryRoot: resolve(dirname(resolve(sourceEntry)), "../../..") }
            : {}),
        });
      },
      prepareMigration: () => prepareLegacyInstallation({ legacyPaths, paths }),
      preflight: async () => {
        const messages = createProntoMessages({ imsgPath: discovery.imsgPath });
        try {
          const transport = new ImsgTransport(messages);
          const imsg = await transport.qualify();
          const watch = await transport.watch({
            onActivation: () => undefined,
            tags: config.tags,
          });
          await watch.close();
          printCheck({ id: "imessage-read-watch", status: "ok" });
          for (const capability of imsg.degraded) {
            printCheck({ id: `imessage-${capability}`, status: "degraded" });
          }
        } catch (error) {
          printCheck({
            id: "imessage-read-watch",
            remediation: "Grant Full Disk Access to this setup terminal and verify imsg RPC access.",
            status: "failed",
          });
          throw new Error(
            "Setup stopped before installation because iMessage qualification failed.",
            { cause: error },
          );
        } finally {
          await messages.close().catch(() => undefined);
        }
        console.log("Qualifying each selected runtime with one temporary, noninteractive file-tool probe...");
        for (const [kind, executablePath] of [
          [config.primaryRuntime, config.primaryRuntimePath],
          [config.fallbackRuntime, config.fallbackRuntimePath],
        ] as const) {
          if (kind === undefined || executablePath === undefined) continue;
          const result = await qualifyRuntime({
            adapter: createRuntimeAdapter(kind, executablePath),
            ...(bridgeExecutableArgs === undefined ? {} : { bridgeExecutableArgs }),
            bridgeExecutablePath,
            commandRunner: runCommand,
            workingDirectory: config.workingDirectory,
          });
          for (const check of result.checks) printCheck(check);
          if (!result.qualified) {
            throw new Error(
              "Setup stopped before installation because runtime qualification failed.",
            );
          }
        }
      },
      qualify: async () => {
        console.log(fullDiskAccessInstructions(paths.executablePath));
        await prompt.question("After granting access, press Enter to qualify the installed Pronto executable: ");
        await qualifyInstalledExecutable(paths.executablePath, runCommand, async () => {
          const state = await launchAgentStateForLabel({ label: LAUNCH_AGENT_LABEL });
          if (state === "stopped") return async () => undefined;
          await stopLaunchAgentForLabel({ label: LAUNCH_AGENT_LABEL });
          return async () => await restoreLaunchAgentForLabel({
            label: LAUNCH_AGENT_LABEL,
            plistPath: paths.launchAgentPath,
          });
        });
      },
      removeProntoAgent: async () => {
        await stopLaunchAgentForLabel({ label: UPDATER_LAUNCH_AGENT_LABEL });
        await removeLaunchAgent(paths.launchAgentPath);
      },
      suspendProntoAgent: async () => {
        const suspended: Array<{ label: string; plistPath: string }> = [];
        const restore = async () => {
          for (const agent of [...suspended].reverse()) await restoreLaunchAgentForLabel(agent);
        };
        try {
          for (const agent of [
            { label: UPDATER_LAUNCH_AGENT_LABEL, plistPath: paths.updaterLaunchAgentPath },
            { label: LAUNCH_AGENT_LABEL, plistPath: paths.launchAgentPath },
          ]) {
            if (await launchAgentStateForLabel({ label: agent.label }) === "stopped") continue;
            await stopLaunchAgentForLabel({ label: agent.label });
            suspended.push(agent);
          }
        } catch (error) { await restore(); throw error; }
        return restore;
      },
    });
    console.log(setupCompletionMessage(paths, config.tags));
    return 0;
  } finally {
    prompt.close();
  }
}

async function runUpdate(args: readonly string[]): Promise<number> {
  if (process.platform !== "darwin") {
    console.error("Pronto updates require macOS.");
    return 1;
  }
  const automatic = args.includes("--automatic");
  const checkOnly = args.includes("--check");
  const allowIdentityMigration = args.includes("--migrate-signing");
  const updater = new ProntoUpdater(pathsForHome(homedir()));
  try {
    if (
      allowIdentityMigration &&
      resolve(process.execPath) !== resolve(pathsForHome(homedir()).executablePath)
    ) {
      const result = await updater.migrateLocalCandidate(process.execPath);
      if (result.status === "migration_installed") {
        console.log(fullDiskAccessInstructions(pathsForHome(homedir()).executablePath));
        console.log("After granting access, run pronto doctor and pronto status. Future updates will preserve this identity.");
        return 2;
      }
      console.log(result.status === "installed"
        ? `Pronto migrated to signed ${result.version}.`
        : `Pronto ${result.version} already has the permanent release identity.`);
      return 0;
    }
    if (checkOnly) {
      const result = await updater.check();
      console.log(result.status === "current"
        ? `Pronto ${result.version} is current.`
        : `Pronto ${result.manifest.version} is available.`);
      return 0;
    }
    const result = await updater.install({ allowIdentityMigration });
    if (result.status === "current") {
      if (!automatic) console.log(`Pronto ${result.version} is current.`);
      return 0;
    }
    if (result.status === "migration_required") {
      if (!automatic) {
        console.error(
          `Pronto ${result.version} is signed with the permanent release identity. ` +
          "Run pronto update --migrate-signing to install it; macOS will require one final Full Disk Access re-grant.",
        );
      }
      return automatic ? 0 : 2;
    }
    if (result.status === "migration_installed") {
      console.log(fullDiskAccessInstructions(pathsForHome(homedir()).executablePath));
      console.log("After granting access, run pronto doctor and pronto status. Future updates will preserve this identity.");
      return 2;
    }
    console.log(`Pronto updated to ${result.version}.`);
    return 0;
  } catch (error) {
    console.error(`Pronto update failed: ${(error as Error).message}`);
    return automatic ? 0 : 1;
  }
}

function printCheck(check: { id: string; remediation?: string; status: string }): void {
  console.log(`${check.status.padEnd(8)} ${check.id}`);
  if (check.remediation !== undefined) console.log(`         ${check.remediation}`);
}

async function runDoctor(json = false, offline = false): Promise<number> {
  const paths = pathsForHome(homedir());
  const report = await inspectInstallation(paths);
  if (report.healthy) {
    const config = await loadConfig(paths.configPath);
    const messages = createProntoMessages({ imsgPath: config.imsgPath });
    try {
      const transport = new ImsgTransport(messages);
      const imsg = await transport.qualify();
      const watch = await transport.watch({
        onActivation: () => undefined,
        tags: config.tags,
      });
      await watch.close();
      report.checks.push({ id: "imessage-read-watch", status: "ok" });
      for (const capability of imsg.degraded) {
        report.checks.push({
          id: `imessage-${capability}`,
          remediation: `Update or reconfigure imsg to expose ${capability}; core tagged replies remain available.`,
          status: "degraded",
        });
      }
      report.checks.push({
        id: "messages-send-automation",
        remediation: "A real send cannot be tested without messaging a chat; complete the documented live smoke after setup.",
        status: "degraded",
      });
    } catch {
      report.checks.push({
        id: "imessage-read-watch",
        remediation: "Grant Full Disk Access to the installed pronto executable and verify imsg RPC access.",
        status: "failed",
      });
    } finally {
      await messages.close().catch(() => undefined);
    }

    for (const [kind, executablePath] of [
      [config.primaryRuntime, config.primaryRuntimePath],
      [config.fallbackRuntime, config.fallbackRuntimePath],
    ] as const) {
      if (kind === undefined || executablePath === undefined) continue;
      const qualification = await qualifyRuntime({
        adapter: createRuntimeAdapter(kind, executablePath),
        bridgeExecutablePath: paths.executablePath,
        commandRunner: runCommand,
        workingDirectory: config.workingDirectory,
      });
      report.checks.push(...qualification.checks);
    }
    if (!offline) {
      const listener = await runCommand("/bin/launchctl", [
        "print",
        `gui/${process.getuid?.() ?? 0}/${LAUNCH_AGENT_LABEL}`,
      ]);
      const database = openProntoDatabase(paths.databasePath);
      let daemonHealth;
      try {
        daemonHealth = new DeliveryJournal(database).daemonHealth();
      } finally {
        database.close();
      }
      report.checks.push(
        parseLaunchAgentState(listener) === "running" && daemonHealth?.state === "ready"
          ? { id: "installed-service-runtime", status: "ok" }
          : {
            id: "installed-service-runtime",
            remediation:
              "The installed launchd process has not reported ready. Check the private log and re-grant Full Disk Access to the installed executable.",
            status: "failed",
          },
      );
    }
    report.healthy = report.checks.every((check) => check.status !== "failed");
  }
  if (json) console.log(JSON.stringify(report));
  else {
    for (const check of report.checks) printCheck(check);
  }
  return report.healthy ? 0 : 1;
}

async function runStatus(json: boolean, includeChats: boolean): Promise<number> {
  const paths = pathsForHome(homedir());
  const listener = await runCommand("/bin/launchctl", [
    "print",
    `gui/${process.getuid?.() ?? 0}/${LAUNCH_AGENT_LABEL}`,
  ]);
  const listenerState = parseLaunchAgentState(listener);
  const database = openProntoDatabase(paths.databasePath);
  try {
    const journal = new DeliveryJournal(database);
    const daemonHealth = journal.daemonHealth();
    const status = {
      database: "ready",
      daemon: daemonHealth?.state ?? "unknown",
      degradedCapabilities: journal.degradedCapabilities(),
      listener: listenerState,
      ...journal.operationalStatus(includeChats),
    };
    if (json) console.log(JSON.stringify(status));
    else {
      console.log(`listener   ${status.listener}`);
      console.log(`database   ${status.database}`);
      console.log(`daemon     ${status.daemon}`);
      console.log(`active     ${status.active}`);
      console.log(`ambiguous  ${status.ambiguous}`);
      console.log(`parked     ${status.parked}`);
      console.log(`limited    ${status.rateLimited}`);
      console.log(`last       ${status.lastSettledAt ?? "none"}`);
      for (const capability of status.degradedCapabilities) {
        console.log(`degraded   ${capability}`);
      }
      for (const chat of status.chats ?? []) console.log(`chat       ${chat}`);
    }
    return listenerState === "running" && daemonHealth?.state === "ready" ? 0 : 1;
  } finally {
    database.close();
  }
}

async function runDaemon(): Promise<number> {
  const paths = pathsForHome(homedir());
  const config = await loadConfig(paths.configPath);
  const daemon = new ProntoDaemon(config, paths);
  const stop = () => daemon.stop();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    try {
      await daemon.run();
    } catch {
      console.error(
        JSON.stringify({ component: "daemon", reason: "startup-or-transport-failure", state: "failed" }),
      );
      return 1;
    }
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
  return 0;
}

async function runUninstall(args: readonly string[]): Promise<number> {
  const paths = pathsForHome(homedir());
  if (args.includes("--purge")) {
    if (!args.includes("--confirm-purge")) {
      console.error("Full purge requires both --purge and --confirm-purge.");
      return 2;
    }
    await uninstallInstallation({ paths, purge: true });
    console.log("Pronto and its private state were removed.");
  } else {
    await uninstallInstallation({ paths });
    console.log("Pronto was removed; configuration and conversation state were retained.");
  }
  return 0;
}

async function runTags(args: readonly string[]): Promise<number> {
  const paths = pathsForHome(homedir());
  const config = await loadConfig(paths.configPath);
  const [action = "list", value, extra] = args;

  if (action === "list") {
    if (value !== undefined) {
      console.error("Usage: pronto tags [list|add <tag>|remove <tag>]");
      return 2;
    }
    for (const tag of config.tags) console.log(tag);
    return 0;
  }
  if ((action !== "add" && action !== "remove") || value === undefined || extra !== undefined) {
    console.error("Usage: pronto tags [list|add <tag>|remove <tag>]");
    return 2;
  }

  let tags: string[];
  let normalizedValue: string;
  try {
    normalizedValue = normalizeTags([value])[0]!;
    if (
      action === "remove" &&
      config.conductor?.tag === normalizedValue
    ) {
      throw new Error(
        `Tag ${normalizedValue} is reserved for Conductor; run pronto conductor disable`,
      );
    }
    tags = action === "add" ? addTag(config.tags, value) : removeTag(config.tags, value);
  } catch (error) {
    console.error((error as Error).message);
    return 2;
  }
  if (tags.length === config.tags.length && tags.every((tag, index) => tag === config.tags[index])) {
    console.log(`${normalizedValue} is already configured.`);
    return 0;
  }

  await saveConfig(paths.configPath, { ...config, tags });
  const restarted = await restartLaunchAgent();
  if (restarted.exitCode !== 0) {
    console.error("Tags were saved, but the listener could not restart. Run pronto setup to repair it.");
    return 1;
  }
  console.log(`Configured tags: ${tags.join(", ")}`);
  return 0;
}

function configuredRuntimePath(
  config: ProntoConfig,
  agent: LocalRuntimeKind,
): string | undefined {
  if (config.primaryRuntime === agent) return config.primaryRuntimePath;
  if (config.fallbackRuntime === agent) return config.fallbackRuntimePath;
  return undefined;
}

function expandedPath(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return resolve(path);
}

async function runWorktree(args: readonly string[]): Promise<number> {
  const paths = pathsForHome(homedir());
  let config: ProntoConfig;
  try {
    config = await loadConfig(paths.configPath);
  } catch {
    console.error("Run pronto setup before binding a worktree.");
    return 1;
  }

  const [action = "list", ...rest] = args;
  if (action === "list") {
    if (rest.length !== 0) {
      console.error("Usage: pronto worktree [list|bind <chat-key> <path> --agent <codex|claude>|unbind <chat-key>]");
      return 2;
    }
    const database = openProntoDatabase(paths.databasePath);
    try {
      for (const binding of new WorktreeBindingStore(database).list()) {
        console.log(`${binding.chatKey}\t${binding.agent}\t${binding.worktreePath}`);
      }
    } finally {
      database.close();
    }
    return 0;
  }

  if (action === "unbind") {
    const [chatKey, extra] = rest;
    if (
      chatKey === undefined ||
      extra !== undefined ||
      !/^[A-Za-z0-9_-]{8,128}$/u.test(chatKey)
    ) {
      console.error("Usage: pronto worktree unbind <chat-key>");
      return 2;
    }
    const database = openProntoDatabase(paths.databasePath);
    try {
      if (!new WorktreeBindingStore(database).delete(chatKey)) {
        console.error(`No worktree binding exists for ${chatKey}.`);
        return 1;
      }
    } finally {
      database.close();
    }
    console.log(`Removed the worktree binding for ${chatKey}.`);
    return 0;
  }

  if (action !== "bind") {
    console.error("Usage: pronto worktree [list|bind <chat-key> <path> --agent <codex|claude>|unbind <chat-key>]");
    return 2;
  }
  const [chatKey, requestedPath, agentFlag, rawAgent, extra] = rest;
  if (
    chatKey === undefined ||
    requestedPath === undefined ||
    agentFlag !== "--agent" ||
    (rawAgent !== "codex" && rawAgent !== "claude") ||
    extra !== undefined ||
    !/^[A-Za-z0-9_-]{8,128}$/u.test(chatKey)
  ) {
    console.error("Usage: pronto worktree bind <chat-key> <path> --agent <codex|claude>");
    return 2;
  }
  const agent: LocalRuntimeKind = rawAgent;
  if (configuredRuntimePath(config, agent) === undefined) {
    console.error(
      `${agent} is not configured in Pronto. Run pronto setup and select it as the primary or fallback runtime first.`,
    );
    return 2;
  }

  let worktreePath: string;
  try {
    worktreePath = await canonicalLinkedWorktree(expandedPath(requestedPath));
  } catch (error) {
    console.error(`Unable to bind worktree: ${(error as Error).message}`);
    return 1;
  }
  const database = openProntoDatabase(paths.databasePath);
  try {
    new WorktreeBindingStore(database).bind({ agent, chatKey, worktreePath });
  } finally {
    database.close();
  }
  console.log(`Bound ${chatKey} to ${worktreePath} using ${agent}.`);
  console.log("Local tagged turns now use this worktree; the Conductor app chat remains separate.");
  return 0;
}

const CONDUCTOR_DISCLOSURE =
  "Conductor mode sends the authorized request and bounded conversation context to a " +
  "Conductor cloud workspace. Conductor stores cloud session inputs and outputs, and the " +
  "selected coding agent can change files in that cloud workspace. The Conductor tag is " +
  "still not authentication: any participant in an eligible chat can invoke it.";

function conductorOptions(args: readonly string[]): {
  readonly flags: Set<string>;
  readonly values: Map<string, string>;
} {
  const booleanFlags = new Set(["--accept-cloud-data", "--fast"]);
  const allowedValues = new Set([
    "--agent",
    "--branch",
    "--effort",
    "--model",
    "--project",
    "--tag",
  ]);
  const flags = new Set<string>();
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index]!;
    if (booleanFlags.has(key)) {
      if (flags.has(key)) throw new Error(`Duplicate option: ${key}`);
      flags.add(key);
      continue;
    }
    if (!allowedValues.has(key)) throw new Error(`Unknown option: ${key}`);
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Missing value for ${key}`);
    }
    if (values.has(key)) throw new Error(`Duplicate option: ${key}`);
    values.set(key, value);
    index += 1;
  }
  return { flags, values };
}

function conductorApiKey(
  configured: string | undefined,
): string | undefined {
  const environment = process.env.CONDUCTOR_API_KEY?.trim();
  return environment === undefined || environment === "" ? configured : environment;
}

async function runConductor(args: readonly string[]): Promise<number> {
  const paths = pathsForHome(homedir());
  const [action = "status", ...rest] = args;
  let config;
  try {
    config = await loadConfig(paths.configPath);
  } catch {
    console.error("Run pronto setup before configuring Conductor.");
    return 1;
  }

  if (action === "projects") {
    if (rest.length !== 0) {
      console.error("Usage: pronto conductor projects");
      return 2;
    }
    const apiKey = conductorApiKey(config.conductor?.apiKey);
    if (apiKey === undefined) {
      console.error("Set CONDUCTOR_API_KEY before listing Conductor projects.");
      return 2;
    }
    try {
      for (const project of await new ConductorApiClient(apiKey).listProjects()) {
        console.log(`${project.id}\t${project.name}\t${project.gitRemote}`);
      }
      return 0;
    } catch (error) {
      console.error(`Unable to list Conductor projects: ${(error as Error).message}`);
      return 1;
    }
  }

  if (action === "configure") {
    let options;
    try {
      options = conductorOptions(rest);
    } catch (error) {
      console.error((error as Error).message);
      return 2;
    }
    if (!options.flags.has("--accept-cloud-data")) {
      console.error(CONDUCTOR_DISCLOSURE);
      console.error("Re-run with --accept-cloud-data to confirm this cloud data flow.");
      return 2;
    }
    const projectId = options.values.get("--project") ?? config.conductor?.projectId;
    const apiKey = conductorApiKey(config.conductor?.apiKey);
    if (projectId === undefined || apiKey === undefined) {
      console.error(
        "Usage: CONDUCTOR_API_KEY=... pronto conductor configure " +
        "--project <project-id> [--agent codex] [--model <model>] " +
        "[--tag @conductor] --accept-cloud-data",
      );
      return 2;
    }
    const agent = (options.values.get("--agent") ??
      config.conductor?.agent ??
      "codex") as ConductorAgentKind;
    const effort = (options.values.get("--effort") ??
      config.conductor?.effort) as ConductorEffort | undefined;
    let conductor;
    try {
      conductor = normalizeConductorConfig({
        agent,
        apiKey,
        ...(options.values.has("--branch")
          ? { branch: options.values.get("--branch")! }
          : config.conductor?.branch === undefined
            ? {}
            : { branch: config.conductor.branch }),
        ...(effort === undefined ? {} : { effort }),
        ...(options.flags.has("--fast")
          ? { fastMode: true }
          : config.conductor?.fastMode === undefined
            ? {}
            : { fastMode: config.conductor.fastMode }),
        ...(options.values.has("--model")
          ? { model: options.values.get("--model")! }
          : config.conductor?.model === undefined
            ? {}
            : { model: config.conductor.model }),
        projectId,
        tag: options.values.get("--tag") ?? config.conductor?.tag ?? "@conductor",
      });
      const project = await new ConductorApiClient(apiKey).getProject(projectId);
      const previousConductorTag = config.conductor?.tag;
      await saveConfig(paths.configPath, {
        ...config,
        conductor,
        tags: addTag(
          previousConductorTag === undefined ||
              previousConductorTag === conductor.tag
            ? config.tags
            : config.tags.filter((tag) => tag !== previousConductorTag),
          conductor.tag,
        ),
      });
      const restarted = await restartLaunchAgent();
      if (restarted.exitCode !== 0) {
        console.error(
          "Conductor was configured, but the listener could not restart. Run pronto setup to repair it.",
        );
        return 1;
      }
      console.log(
        `Configured ${conductor.tag} for Conductor project ${project.name} ` +
        `using ${conductor.agent}${conductor.model === undefined ? "" : `/${conductor.model}`}.`,
      );
      return 0;
    } catch (error) {
      console.error(`Unable to configure Conductor: ${(error as Error).message}`);
      return 1;
    }
  }

  if (action === "disable") {
    if (rest.length !== 0) {
      console.error("Usage: pronto conductor disable");
      return 2;
    }
    if (config.conductor === undefined) {
      console.log("Conductor is not configured.");
      return 0;
    }
    let tags;
    try {
      tags = removeTag(config.tags, config.conductor.tag);
    } catch (error) {
      console.error(`${(error as Error).message}. Add another tag before disabling Conductor.`);
      return 2;
    }
    const { conductor: _conductor, ...withoutConductor } = config;
    await saveConfig(paths.configPath, { ...withoutConductor, tags });
    const restarted = await restartLaunchAgent();
    if (restarted.exitCode !== 0) {
      console.error(
        "Conductor was disabled, but the listener could not restart. Run pronto setup to repair it.",
      );
      return 1;
    }
    console.log("Conductor integration disabled.");
    return 0;
  }

  if (action === "bindings") {
    if (rest.length !== 0) {
      console.error("Usage: pronto conductor bindings");
      return 2;
    }
    const database = openProntoDatabase(paths.databasePath);
    try {
      for (const binding of new ConductorBindingStore(database).list()) {
        console.log(
          `${binding.chatKey}\t${binding.workspaceName}\t${binding.deepLink}`,
        );
      }
    } finally {
      database.close();
    }
    return 0;
  }

  if (action === "status") {
    if (rest.length !== 0) {
      console.error("Usage: pronto conductor status");
      return 2;
    }
    if (config.conductor === undefined) {
      console.log("disabled");
      return 0;
    }
    console.log(`tag       ${config.conductor.tag}`);
    console.log(`project   ${config.conductor.projectId}`);
    console.log(`agent     ${config.conductor.agent}`);
    console.log(`model     ${config.conductor.model ?? "default"}`);
    console.log(`branch    ${config.conductor.branch ?? "default"}`);
    return 0;
  }

  console.error(
    "Usage: pronto conductor [status|projects|configure|bindings|disable]",
  );
  return 2;
}

export async function runCli(args: readonly string[]): Promise<number> {
  const [command] = args;

  if (command === "--version" || command === "-v") {
    console.log(`pronto ${packageJson.version}`);
    return 0;
  }

  if (command === undefined || command === "--help" || command === "-h") {
    console.log(HELP);
    return 0;
  }

  if (command === "setup") return runSetup();
  if (command === "mcp") {
    const brokerUrl = process.env[PRONTO_BROKER_URL_ENV];
    const capability = process.env[PRONTO_ATTEMPT_CAPABILITY_ENV];
    if (brokerUrl === undefined || capability === undefined) {
      console.error("The current-chat MCP server requires a turn-scoped capability.");
      return 1;
    }
    await runMcpStdio((name, toolArgs) => brokerQuery(brokerUrl, capability, name, toolArgs));
    return 0;
  }
  if (command === "run") return runDaemon();
  if (command === "doctor") return runDoctor(args.includes("--json"), args.includes("--offline"));
  if (command === "status") return runStatus(args.includes("--json"), args.includes("--chats"));
  if (command === "tags" || command === "tag") return runTags(args.slice(1));
  if (command === "worktree") return runWorktree(args.slice(1));
  if (command === "conductor") return runConductor(args.slice(1));
  if (command === "update") return runUpdate(args.slice(1));
  if (command === "stop") {
    const result = await stopLaunchAgent();
    if (result.exitCode !== 0) console.error("Pronto was not running.");
    return result.exitCode === 0 ? 0 : 1;
  }
  if (command === "forget") {
    const chatKey = args[1];
    if (chatKey === undefined || !/^[A-Za-z0-9_-]{8,128}$/.test(chatKey)) {
      console.error("Usage: pronto forget <chat-key>");
      return 2;
    }
    const database = openProntoDatabase(pathsForHome(homedir()).databasePath);
    try {
      new MemoryStore(database).forget(chatKey);
    } finally {
      database.close();
    }
    console.log("Tagged memory and workspace state for the selected chat were removed.");
    return 0;
  }
  if (command === "uninstall") return runUninstall(args.slice(1));

  console.error(`Unknown command: ${command}`);
  console.error("Run pronto --help for usage.");
  return 2;
}

if (import.meta.main) {
  process.exitCode = await runCli(process.argv.slice(2));
}
