import type { LocalRuntimeKind } from "../config";
import { ClaudeAdapter } from "./claude";
import { CodexAdapter } from "./codex";
import type { RuntimeAdapter } from "./types";

export function createRuntimeAdapter(
  kind: LocalRuntimeKind,
  path: string,
): RuntimeAdapter & { kind: LocalRuntimeKind } {
  return kind === "codex" ? new CodexAdapter(path) : new ClaudeAdapter(path);
}
