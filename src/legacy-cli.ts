#!/usr/bin/env bun

import { runCli } from "./cli";

console.error("s4imsg is now Pronto; use the pronto command.");

if (import.meta.main) {
  process.exitCode = await runCli(process.argv.slice(2));
}
