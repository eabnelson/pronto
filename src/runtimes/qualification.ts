import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { RuntimeKind } from "../config";
import type { CommandRunner, DoctorCheck } from "../macos/setup";
import type { RuntimeAdapter } from "./types";

const REQUIRED_HELP: Record<RuntimeKind, readonly string[]> = {
  claude: [
    "--dangerously-skip-permissions",
    "--mcp-config",
    "--json-schema",
    "--no-session-persistence",
    "stream-json",
  ],
  codex: ["--dangerously-bypass-approvals-and-sandbox", "--ephemeral", "--json", "--output-schema"],
};

function failed(id: string, remediation: string): DoctorCheck {
  return { id, remediation, status: "failed" };
}

export interface RuntimeQualification {
  checks: DoctorCheck[];
  qualified: boolean;
}

export async function qualifyRuntime(input: {
  adapter: RuntimeAdapter;
  bridgeExecutableArgs?: readonly string[];
  bridgeExecutablePath: string;
  commandRunner: CommandRunner;
  workingDirectory: string;
}): Promise<RuntimeQualification> {
  const { adapter, commandRunner } = input;
  const checks: DoctorCheck[] = [];
  const version = await commandRunner(adapter.executablePath, ["--version"]);
  checks.push(
    version.exitCode === 0
      ? { id: `${adapter.kind}-version`, status: "ok" }
      : failed(`${adapter.kind}-version`, `Repair the configured ${adapter.kind} executable.`),
  );

  const authArgs = adapter.kind === "codex" ? ["login", "status"] : ["auth", "status"];
  const auth = await commandRunner(adapter.executablePath, authArgs);
  checks.push(
    auth.exitCode === 0
      ? { id: `${adapter.kind}-authentication`, status: "ok" }
      : failed(
          `${adapter.kind}-authentication`,
          `Authenticate ${adapter.kind} in this macOS user account, then run doctor again.`,
        ),
  );

  const helpArgs = adapter.kind === "codex" ? ["exec", "--help"] : ["--help"];
  const help = await commandRunner(adapter.executablePath, helpArgs);
  const helpText = `${help.stdout}\n${help.stderr}`;
  const missingFlags = REQUIRED_HELP[adapter.kind].filter((flag) => !helpText.includes(flag));
  checks.push(
    help.exitCode === 0 && missingFlags.length === 0
      ? { id: `${adapter.kind}-noninteractive-interface`, status: "ok" }
      : failed(
          `${adapter.kind}-noninteractive-interface`,
          `Update ${adapter.kind}; its CLI is missing required noninteractive or per-invocation MCP capabilities.`,
        ),
  );

  if (checks.some((check) => check.status === "failed")) {
    return { checks, qualified: false };
  }

  const directory = await mkdtemp(join(tmpdir(), `s4imsg-${adapter.kind}-qualification-`));
  await chmod(directory, 0o700);
  const markerPath = join(directory, "permission-probe.txt");
  const marker = randomBytes(24).toString("base64url");
  try {
    const result = await adapter.run({
      ...(input.bridgeExecutableArgs === undefined
        ? {}
        : { bridgeExecutableArgs: input.bridgeExecutableArgs }),
      bridgeExecutablePath: input.bridgeExecutablePath,
      brokerUrl: "http://127.0.0.1:1",
      capability: randomBytes(32).toString("base64url"),
      prompt: [
        "AUTHORIZED LOCAL QUALIFICATION REQUEST",
        `Use your normal local file tools to create ${markerPath} containing exactly: ${marker}`,
        "Do not call the s4imsg current-chat tools. Then return a short confirmation reply.",
      ].join("\n"),
      workingDirectory: input.workingDirectory,
    });
    const markerMatches =
      result.status === "success" &&
      (await readFile(markerPath, "utf8").catch(() => "")).trim() === marker;
    const remediation =
      result.status !== "success" && result.reason !== "permission-denial"
        ? `Repair ${adapter.kind}'s configured noninteractive environment (${result.reason}), then run setup or doctor again.`
        : `Allow ${adapter.kind} to run in unrestricted no-prompt mode, then run setup or doctor again.`;
    checks.push(
      markerMatches
        ? { id: `${adapter.kind}-effective-permissions`, status: "ok" }
        : failed(`${adapter.kind}-effective-permissions`, remediation),
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }

  return { checks, qualified: checks.every((check) => check.status !== "failed") };
}
