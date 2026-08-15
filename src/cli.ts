#!/usr/bin/env bun

import packageJson from "../package.json" with { type: "json" };

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

export function runCli(args: readonly string[]): number {
  const [command] = args;

  if (command === "--version" || command === "-v") {
    console.log(`s4imsg ${packageJson.version}`);
    return 0;
  }

  if (command === undefined || command === "--help" || command === "-h") {
    console.log(HELP);
    return 0;
  }

  console.error(`Unknown command: ${command}`);
  console.error("Run s4imsg --help for usage.");
  return 2;
}

if (import.meta.main) {
  process.exitCode = runCli(process.argv.slice(2));
}
