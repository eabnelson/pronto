#!/usr/bin/env bun

import { runCli } from "./cli";
import { compatibilityNotice, compatibilityRejection } from "./compatibility";

console.error(compatibilityNotice());

if (import.meta.main) {
  const args = process.argv.slice(2);
  const rejection = compatibilityRejection(args[0]);
  if (rejection !== null) {
    console.error(rejection);
    process.exitCode = 2;
  } else {
    process.exitCode = await runCli(args);
  }
}
