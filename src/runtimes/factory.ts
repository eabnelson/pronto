import type { RuntimeKind } from "../config";
import { ClaudeAdapter } from "./claude";
import { CodexAdapter } from "./codex";
import type { RuntimeAdapter } from "./types";

export function createRuntimeAdapter(kind: RuntimeKind, path: string): RuntimeAdapter {
  return kind === "codex" ? new CodexAdapter(path) : new ClaudeAdapter(path);
}
