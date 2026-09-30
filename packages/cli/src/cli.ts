#!/usr/bin/env bun

import packageJson from "../package.json" with { type: "json" };
import { createInterface } from "node:readline/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { stdin, stdout } from "node:process";
import {
  addTagToApps,
  createConfig,
  channelTags,
  enabledChannels,
  loadConfig,
  normalizeTag,
  normalizeTags,
  removeTagFromApps,
  saveConfig,
  tagAssignments,
  type ProntoConfig,
  WHATSAPP_RISK_CONSENT_VERSION,
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
  type DoctorCheck,
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
import { ProntoDaemon, STANDALONE_SCOPE_TTL_MS } from "./core/daemon";
import {
  linkWhatsappInTerminal,
  standaloneWhatsapp,
  WHATSAPP_DISCLOSURE,
} from "./whatsapp/standalone";
import { qualifyRuntime } from "./runtimes/qualification";
import { createRuntimeAdapter } from "./runtimes/factory";
import { ImsgTransport } from "./imessage/transport";
import { DeliveryJournal } from "./storage/journal";
import { CHANNEL_LABELS, type ChannelKind } from "./channels/types";
import {
  appList,
  parseAppFlags,
  parseTagAppChoice,
  tagAppChoices,
  tagAppPrompt,
} from "./tag-apps";
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
  tags        List, add, or remove trigger tags and the apps they apply to
  whatsapp    Link or unlink WhatsApp
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
    const installedApps: ChannelKind[] = [
      ...(discovery.imsgPath === undefined ? [] : ["imessage" as const]),
      ...(discovery.wacliPath === undefined ? [] : ["whatsapp" as const]),
    ];
    const appChoices = tagAppChoices(installedApps);
    let apps = appChoices[0]!.apps;
    if (appChoices.length > 1) {
      const options = appChoices.map((choice, index) => {
        return `  ${index + 1}. ${choice.label}${index === 0 ? " (default)" : ""}`;
      });
      while (true) {
        const chosen = parseTagAppChoice(await prompt.question(
          `Which messaging apps should Pronto answer in?\n${options.join("\n")}\nChoose [1]: `,
        ), appChoices);
        if (chosen !== null) {
          apps = chosen;
          break;
        }
        console.error("Choose one of the listed numbers.");
      }
    }
    const defaultTags = existing?.tags ?? ["@s4"];
    const tagAnswer = (await prompt.question(
      `Trigger tags, separated by commas [${defaultTags.join(", ")}]: `,
    )).trim();
    const tags = tagAnswer === ""
      ? defaultTags
      : normalizeTags(tagAnswer.split(",").map((tag) => tag.trim()));
    const tagApps: Record<string, ChannelKind[]> = {};
    const tagChoices = tagAppChoices(apps);
    for (const tag of tagChoices.length > 1 ? tags : []) {
      while (true) {
        const chosen = parseTagAppChoice(await prompt.question(tagAppPrompt(tag, tagChoices)), tagChoices);
        if (chosen !== null) {
          tagApps[tag] = chosen;
          break;
        }
        console.error("Choose one of the listed numbers.");
      }
    }
    for (const app of apps) {
      if (!tags.some((tag) => (tagApps[tag] ?? apps).includes(app))) {
        console.error(`Give ${CHANNEL_LABELS[app]} at least one tag.`);
        return 1;
      }
    }
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
    if (apps.includes("whatsapp")) {
      console.log(`\n${WHATSAPP_DISCLOSURE}\n`);
      const accepted = (await prompt.question("Type yes to use WhatsApp with this risk: "))
        .trim()
        .toLowerCase();
      if (accepted !== "yes") {
        console.error("Setup cancelled without changing the service.");
        return 1;
      }
    }

    const workingDirectory = selection.exists
      ? selection.path
      : await createWorkspaceDirectory(selection.path);
    const config = prepareSetupConfig({
      apps,
      ...(existing === null ? {} : { chatKeySalt: existing.chatKeySalt }),
      discovery,
      ...(wantsFallback && fallbackCandidate !== undefined
        ? { fallbackRuntime: fallbackCandidate }
        : {}),
      primaryRuntime: primaryAnswer,
      tagApps,
      tags,
      ...(apps.includes("whatsapp") ? { whatsappRiskConsentVersion: WHATSAPP_RISK_CONSENT_VERSION } : {}),
      workingDirectory,
    });
    const whatsappConfig = config.channels.whatsapp;
    if (whatsappConfig !== undefined) {
      const whatsapp = standaloneWhatsapp({
        chatKeySalt: config.chatKeySalt,
        paths,
        scopeTtlMs: STANDALONE_SCOPE_TTL_MS,
        wacliPath: whatsappConfig.wacliPath,
      });
      try {
        if ((await whatsapp.qualify()).status === "needs_link") {
          console.log("\nLink this Mac to WhatsApp.");
          await linkWhatsappInTerminal(whatsapp);
        }
        printCheck({ id: "whatsapp-linked", status: "ok" });
      } finally {
        await whatsapp.close().catch(() => undefined);
      }
    }
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
        const imessage = config.channels.imessage;
        if (imessage !== undefined) await imessagePreflight(imessage.imsgPath, imessage.tags);
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
        if (config.channels.imessage !== undefined) {
          console.log(fullDiskAccessInstructions(paths.executablePath));
          await prompt.question("After granting access, press Enter to qualify the installed Pronto executable: ");
        }
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
    console.log(setupCompletionMessage(paths, Object.fromEntries(
      enabledChannels(config).map((app) => [app, channelTags(config, app)]),
    )));
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

async function imessagePreflight(imsgPath: string, tags: readonly string[]): Promise<void> {
  const messages = createProntoMessages({ imsgPath });
  try {
    const transport = new ImsgTransport(messages);
    const imsg = await transport.qualify();
    const watch = await transport.watch({
      onActivation: () => undefined,
      tags,
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
}

async function whatsappDoctorCheck(
  config: ProntoConfig,
  paths: ReturnType<typeof pathsForHome>,
): Promise<DoctorCheck> {
  const whatsapp = standaloneWhatsapp({
    chatKeySalt: config.chatKeySalt,
    paths,
    scopeTtlMs: STANDALONE_SCOPE_TTL_MS,
    wacliPath: config.channels.whatsapp!.wacliPath,
  });
  try {
    const qualification = await whatsapp.qualify();
    return qualification.status === "ready"
      ? { id: "whatsapp-linked", status: "ok" }
      : { id: "whatsapp-linked", remediation: "Run pronto whatsapp link.", status: "failed" };
  } catch (error) {
    return {
      id: "whatsapp-linked",
      remediation: `${(error as Error).message}. Install or upgrade wacli (brew install openclaw/tap/wacli).`,
      status: "failed",
    };
  } finally {
    await whatsapp.close().catch(() => undefined);
  }
}

const WHATSAPP_USAGE = "Usage: pronto whatsapp [link [--phone <number>] | unlink]";

async function runWhatsapp(args: readonly string[]): Promise<number> {
  const [action, ...rest] = args;
  const paths = pathsForHome(homedir());
  const config = await loadConfig(paths.configPath);
  if (action === "unlink" && rest.length === 0) return await unlinkWhatsapp(config, paths);
  const phoneIndex = rest.indexOf("--phone");
  const phone = phoneIndex === -1 ? undefined : rest[phoneIndex + 1];
  if (action !== "link" || (phoneIndex === -1 ? rest.length !== 0 : rest.length !== 2 || phone === undefined)) {
    console.error(WHATSAPP_USAGE);
    return 2;
  }

  const wacliPath = config.channels.whatsapp?.wacliPath ?? Bun.which("wacli");
  if (wacliPath === null || !isAbsolute(wacliPath)) {
    console.error("wacli was not found on PATH. Install it with: brew install openclaw/tap/wacli");
    return 1;
  }
  const prompt = createInterface({ input: stdin, output: stdout });
  let next: ProntoConfig;
  try {
    const existing = config.channels.whatsapp;
    let tags = existing?.tags;
    if (existing === undefined) {
      console.log(`${WHATSAPP_DISCLOSURE}\n`);
      const accepted = (await prompt.question("Type yes to use WhatsApp with this risk: "))
        .trim()
        .toLowerCase();
      if (accepted !== "yes") {
        console.error("WhatsApp was not enabled.");
        return 1;
      }
      const defaults = tagAssignments(config).map(({ tag }) => tag);
      const answer = (await prompt.question(
        `WhatsApp trigger tags, separated by commas [${defaults.join(", ")}]: `,
      )).trim();
      tags = answer === "" ? defaults : normalizeTags(answer.split(",").map((tag) => tag.trim()));
    }
    next = createConfig({
      ...config,
      channels: {
        ...config.channels,
        whatsapp: {
          enabled: true,
          riskConsentVersion: WHATSAPP_RISK_CONSENT_VERSION,
          tags: tags!,
          wacliPath,
        },
      },
    });
  } catch (error) {
    console.error((error as Error).message);
    return 2;
  } finally {
    prompt.close();
  }

  const whatsapp = standaloneWhatsapp({
    chatKeySalt: next.chatKeySalt,
    paths,
    scopeTtlMs: STANDALONE_SCOPE_TTL_MS,
    wacliPath,
  });
  try {
    if ((await whatsapp.qualify()).status === "needs_link") {
      await linkWhatsappInTerminal(whatsapp, phone === undefined ? {} : { phone });
    }
  } catch (error) {
    console.error((error as Error).message);
    return 1;
  } finally {
    await whatsapp.close().catch(() => undefined);
  }
  await saveConfig(paths.configPath, next);
  const restarted = await restartLaunchAgent();
  if (restarted.exitCode !== 0) {
    console.error("WhatsApp is linked, but the listener could not restart. Run pronto setup to repair it.");
    return 1;
  }
  console.log(`WhatsApp is linked. Tags: ${channelTags(next, "whatsapp").join(", ")}`);
  return 0;
}

async function unlinkWhatsapp(
  config: ProntoConfig,
  paths: ReturnType<typeof pathsForHome>,
): Promise<number> {
  const existing = config.channels.whatsapp;
  if (existing === undefined) {
    console.log("WhatsApp is not set up.");
    return 0;
  }
  const whatsapp = standaloneWhatsapp({
    chatKeySalt: config.chatKeySalt,
    paths,
    scopeTtlMs: STANDALONE_SCOPE_TTL_MS,
    wacliPath: existing.wacliPath,
  });
  try {
    await whatsapp.unlink();
  } catch (error) {
    console.error(`WhatsApp could not be unlinked: ${(error as Error).message}`);
    return 1;
  } finally {
    await whatsapp.close().catch(() => undefined);
  }
  const othersEnabled = enabledChannels(config).some((app) => app !== "whatsapp");
  if (othersEnabled) {
    await saveConfig(paths.configPath, {
      ...config,
      channels: { ...config.channels, whatsapp: { ...existing, enabled: false } },
    });
    await restartLaunchAgent();
    console.log("WhatsApp is unlinked and turned off. Run pronto whatsapp link to use it again.");
  } else {
    console.log("WhatsApp is unlinked. It is the only enabled app, so Pronto will report it as needing a link.");
  }
  return 0;
}

async function imessageDoctorChecks(
  imsgPath: string,
  tags: readonly string[],
): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const messages = createProntoMessages({ imsgPath });
  try {
    const transport = new ImsgTransport(messages);
    const imsg = await transport.qualify();
    const watch = await transport.watch({
      onActivation: () => undefined,
      tags,
    });
    await watch.close();
    checks.push({ id: "imessage-read-watch", status: "ok" });
    for (const capability of imsg.degraded) {
      checks.push({
        id: `imessage-${capability}`,
        remediation: `Update or reconfigure imsg to expose ${capability}; core tagged replies remain available.`,
        status: "degraded",
      });
    }
    checks.push({
      id: "messages-send-automation",
      remediation: "A real send cannot be tested without messaging a chat; complete the documented live smoke after setup.",
      status: "degraded",
    });
  } catch {
    checks.push({
      id: "imessage-read-watch",
      remediation: "Grant Full Disk Access to the installed pronto executable and verify imsg RPC access.",
      status: "failed",
    });
  } finally {
    await messages.close().catch(() => undefined);
  }
  return checks;
}

async function runDoctor(json = false, offline = false): Promise<number> {
  const paths = pathsForHome(homedir());
  const report = await inspectInstallation(paths);
  if (report.healthy) {
    const config = await loadConfig(paths.configPath);
    const imessage = config.channels.imessage;
    if (imessage?.enabled === true) {
      report.checks.push(...await imessageDoctorChecks(imessage.imsgPath, imessage.tags));
    }
    if (config.channels.whatsapp?.enabled === true) {
      report.checks.push(await whatsappDoctorCheck(config, paths));
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
      channels: await channelStatus(paths.configPath, journal.channelHealth()),
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
      for (const [kind, channel] of Object.entries(status.channels)) {
        const tags = channel.tags === undefined ? "" : ` ${channel.tags.join(", ")}`;
        console.log(`${kind.padEnd(10)} ${channel.state}${tags}`);
      }
      for (const chat of status.chats ?? []) console.log(`chat       ${chat}`);
    }
    return listenerState === "running" && daemonHealth?.state === "ready" ? 0 : 1;
  } finally {
    database.close();
  }
}

// Status must stay usable as the updater's health probe, so configuration is best-effort here.
async function channelStatus(
  configPath: string,
  health: ReturnType<DeliveryJournal["channelHealth"]>,
): Promise<Partial<Record<ChannelKind, { reason?: string; state: string; tags?: string[] }>>> {
  const config = await loadConfig(configPath).catch(() => null);
  const kinds = config === null
    ? Object.keys(health) as ChannelKind[]
    : enabledChannels(config);
  return Object.fromEntries(kinds.map((kind) => {
    const current = health[kind];
    return [kind, {
      ...(current?.reason === undefined ? {} : { reason: current.reason }),
      state: current?.state ?? "unknown",
      ...(config === null ? {} : { tags: channelTags(config, kind) }),
    }];
  }));
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

const TAGS_USAGE = "Usage: pronto tags [list [--json] | add <tag> [--app <app>]... | remove <tag> [--app <app>]...]";

async function runTags(args: readonly string[]): Promise<number> {
  const paths = pathsForHome(homedir());
  const config = await loadConfig(paths.configPath);
  let parsed: ReturnType<typeof parseAppFlags>;
  try {
    parsed = parseAppFlags(args);
  } catch (error) {
    console.error((error as Error).message);
    return 2;
  }
  const [action = "list", value, extra] = parsed.positional;
  const enabled = enabledChannels(config);

  if (action === "list") {
    if (value !== undefined || parsed.apps.length > 0) {
      console.error(TAGS_USAGE);
      return 2;
    }
    const assignments = tagAssignments(config);
    if (parsed.json) console.log(JSON.stringify(assignments));
    else {
      for (const { apps, tag } of assignments) {
        console.log(enabled.length > 1 ? `${tag.padEnd(12)} ${appList(apps)}` : tag);
      }
    }
    return 0;
  }
  if ((action !== "add" && action !== "remove") || value === undefined || extra !== undefined) {
    console.error(TAGS_USAGE);
    return 2;
  }

  let next: ProntoConfig;
  let normalizedValue: string;
  try {
    normalizedValue = normalizeTag(value);
    for (const app of parsed.apps) {
      if (!enabled.includes(app)) throw new Error(`${CHANNEL_LABELS[app]} is not enabled`);
    }
    let apps = parsed.apps;
    if (apps.length === 0 && action === "add") apps = await chooseTagApps(normalizedValue, enabled);
    if (apps.length === 0) apps = enabled;
    next = action === "add"
      ? addTagToApps(config, value, apps)
      : removeTagFromApps(config, value, apps);
  } catch (error) {
    console.error((error as Error).message);
    return 2;
  }
  if (JSON.stringify(next.channels) === JSON.stringify(config.channels)) {
    console.log(`${normalizedValue} is already configured.`);
    return 0;
  }

  await saveConfig(paths.configPath, next);
  const restarted = await restartLaunchAgent();
  if (restarted.exitCode !== 0) {
    console.error("Tags were saved, but the listener could not restart. Run pronto setup to repair it.");
    return 1;
  }
  console.log(`Configured tags: ${tagAssignments(next).map(({ apps, tag }) => {
    return enabled.length > 1 ? `${tag} (${appList(apps)})` : tag;
  }).join(", ")}`);
  return 0;
}

/** Asks which apps a new tag applies to when more than one is enabled; defaults to all of them. */
async function chooseTagApps(tag: string, enabled: readonly ChannelKind[]): Promise<ChannelKind[]> {
  const choices = tagAppChoices(enabled);
  if (choices.length === 1 || !stdin.isTTY) return [...enabled];
  const prompt = createInterface({ input: stdin, output: stdout });
  try {
    while (true) {
      const apps = parseTagAppChoice(await prompt.question(tagAppPrompt(tag, choices)), choices);
      if (apps !== null) return apps;
      console.error("Choose one of the listed numbers.");
    }
  } finally {
    prompt.close();
  }
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
  if (command === "whatsapp") return runWhatsapp(args.slice(1));
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
