#!/usr/bin/env bun

import packageJson from "../package.json" with { type: "json" };
import { createInterface } from "node:readline/promises";
import { homedir } from "node:os";
import { stdin, stdout } from "node:process";
import { loadConfig } from "./config";
import { stopLaunchAgent } from "./macos/launch-agent";
import { pathsForHome } from "./macos/paths";
import {
  TRUST_DISCLOSURE,
  discoverCommands,
  inspectInstallation,
  installSetup,
  prepareSetupConfig,
  uninstallInstallation,
} from "./macos/setup";
import { openS4imsgDatabase } from "./storage/database";
import { MemoryStore } from "./storage/memory";
import { brokerQuery, runMcpStdio } from "./tools/mcp";

const HELP = `s4imsg ${packageJson.version}

Usage: s4imsg <command>

Commands:
  setup       Configure and install the local listener
  run         Run the listener in the foreground
  status      Show listener health without conversation content
  doctor      Check local capabilities and permissions
  stop        Stop the installed listener
  forget      Remove one chat's tagged memory
  uninstall   Remove the listener while preserving data by default

Options:
  -h, --help     Show this help
  -v, --version  Show the installed version`;

async function runSetup(): Promise<number> {
  if (process.platform !== "darwin") {
    console.error("s4imsg setup requires macOS.");
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
    const tag = (await prompt.question("Trigger tag [@s4]: ")).trim() || "@s4";
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

    console.log(`\n${TRUST_DISCLOSURE}\n`);
    const confirmed = (await prompt.question("Type yes to accept this trust model: "))
      .trim()
      .toLowerCase();
    if (confirmed !== "yes") {
      console.error("Setup cancelled without changing the service.");
      return 1;
    }

    const paths = pathsForHome(homedir());
    const config = prepareSetupConfig({
      discovery,
      ...(wantsFallback && fallbackCandidate !== undefined
        ? { fallbackRuntime: fallbackCandidate }
        : {}),
      primaryRuntime: primaryAnswer,
      tag,
      workingDirectory: homedir(),
    });
    await installSetup({ config, paths, repositoryRoot: process.cwd() });
    console.log("s4imsg installed. Run `s4imsg doctor` to verify local permissions.");
    return 0;
  } finally {
    prompt.close();
  }
}

async function runDoctor(json = false): Promise<number> {
  const report = await inspectInstallation(pathsForHome(homedir()));
  if (json) console.log(JSON.stringify(report));
  else {
    for (const check of report.checks) {
      console.log(`${check.status.padEnd(8)} ${check.id}`);
      if (check.remediation !== undefined) console.log(`         ${check.remediation}`);
    }
  }
  return report.healthy ? 0 : 1;
}

async function runDaemon(): Promise<number> {
  await loadConfig(pathsForHome(homedir()).configPath);
  console.log("s4imsg daemon initialized");
  await new Promise<void>((resolve) => {
    const stop = () => resolve();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
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
    console.log("s4imsg and its private state were removed.");
  } else {
    await uninstallInstallation({ paths });
    console.log("s4imsg was removed; configuration and conversation state were retained.");
  }
  return 0;
}

export async function runCli(args: readonly string[]): Promise<number> {
  const [command] = args;

  if (command === "--version" || command === "-v") {
    console.log(`s4imsg ${packageJson.version}`);
    return 0;
  }

  if (command === undefined || command === "--help" || command === "-h") {
    console.log(HELP);
    return 0;
  }

  if (command === "setup") return runSetup();
  if (command === "mcp") {
    const brokerUrl = process.env.S4IMSG_BROKER_URL;
    const capability = process.env.S4IMSG_ATTEMPT_CAPABILITY;
    if (brokerUrl === undefined || capability === undefined) {
      console.error("The current-chat MCP server requires a turn-scoped capability.");
      return 1;
    }
    await runMcpStdio((name, toolArgs) => brokerQuery(brokerUrl, capability, name, toolArgs));
    return 0;
  }
  if (command === "run") return runDaemon();
  if (command === "doctor") return runDoctor(args.includes("--json"));
  if (command === "status") return runDoctor(args.includes("--json"));
  if (command === "stop") {
    const result = await stopLaunchAgent();
    if (result.exitCode !== 0) console.error("s4imsg was not running.");
    return result.exitCode === 0 ? 0 : 1;
  }
  if (command === "forget") {
    const chatKey = args[1];
    if (chatKey === undefined || !/^[A-Za-z0-9_-]{8,128}$/.test(chatKey)) {
      console.error("Usage: s4imsg forget <chat-key>");
      return 2;
    }
    const database = openS4imsgDatabase(pathsForHome(homedir()).databasePath);
    try {
      new MemoryStore(database).forget(chatKey);
    } finally {
      database.close();
    }
    console.log("Tagged memory for the selected chat was removed.");
    return 0;
  }
  if (command === "uninstall") return runUninstall(args.slice(1));

  console.error(`Unknown command: ${command}`);
  console.error("Run s4imsg --help for usage.");
  return 2;
}

if (import.meta.main) {
  process.exitCode = await runCli(process.argv.slice(2));
}
