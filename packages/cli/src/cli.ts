#!/usr/bin/env bun

import packageJson from "../package.json" with { type: "json" };
import { createInterface } from "node:readline/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { stdin, stdout } from "node:process";
import { addTag, loadConfig, normalizeTags, removeTag, saveConfig } from "./config";
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
import { ImsgTransport } from "./imessage/transport";
import { DeliveryJournal } from "./storage/journal";
import { LAUNCH_AGENT_LABEL } from "./macos/paths";
import { createProntoMessages } from "pronto-imessage";
import {
  PRONTO_ATTEMPT_CAPABILITY_ENV,
  PRONTO_BROKER_URL_ENV,
} from "./tools/contract";

const HELP = `pronto ${packageJson.version}

Usage: pronto <command>

Commands:
  setup       Configure and install the local listener
  run         Run the listener in the foreground
  status      Show listener health without conversation content
  doctor      Check local capabilities and permissions
  tags        List, add, or remove trigger tags
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
      removeProntoAgent: () => removeLaunchAgent(paths.launchAgentPath),
      suspendProntoAgent: async () => {
        const state = await launchAgentStateForLabel({ label: LAUNCH_AGENT_LABEL });
        if (state === "stopped") return async () => undefined;
        await stopLaunchAgentForLabel({ label: LAUNCH_AGENT_LABEL });
        return async () => await restoreLaunchAgentForLabel({
          label: LAUNCH_AGENT_LABEL,
          plistPath: paths.launchAgentPath,
        });
      },
    });
    console.log(setupCompletionMessage(paths, config.tags));
    return 0;
  } finally {
    prompt.close();
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
