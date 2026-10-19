import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { normalizeTag, runtimeSelection, setTagRuntimes, tagAssignments, type ProntoConfig, type RuntimeKind, type RuntimeSelection } from "./config";

const AGENTS = ["codex", "claude"] as const;
const LABELS = { codex: "Codex", claude: "Claude Code" };

async function agentPath(config: ProntoConfig, kind: RuntimeKind): Promise<string | undefined> {
  const configured = [config, ...Object.values(config.tagRuntimes ?? {})];
  const candidates = configured.flatMap((selection) => [
    ...(selection.primaryRuntime === kind && selection.primaryRuntimePath ? [selection.primaryRuntimePath] : []),
    ...(selection.fallbackRuntime === kind && selection.fallbackRuntimePath ? [selection.fallbackRuntimePath] : []),
  ]);
  // Finder-launched menu bar apps don't inherit the owner's shell PATH.
  const path = [...configured.flatMap((entry) => [entry.primaryRuntimePath, entry.fallbackRuntimePath])
    .filter((entry): entry is string => entry !== undefined).map(dirname),
    process.env.PATH ?? "", join(homedir(), ".local/bin"), join(homedir(), ".bun/bin"), "/opt/homebrew/bin", "/usr/local/bin"].join(":");
  const discovered = Bun.which(kind, { PATH: path });
  if (discovered !== null) candidates.push(discovered);
  for (const candidate of new Set(candidates)) {
    if (!isAbsolute(candidate)) continue;
    try {
      await access(candidate, constants.X_OK);
      if ((await stat(candidate)).isFile()) return candidate;
    } catch { /* Try the next installed location. */ }
  }
  return undefined;
}

export async function tagsResponse(config: ProntoConfig) {
  return {
    tags: tagAssignments(config).map((entry) => {
      const selection = runtimeSelection(config, entry.tag);
      return { ...entry, agents: {
        primary: selection.primaryRuntime,
        backup: selection.fallbackRuntime ?? null,
        inherited: config.tagRuntimes?.[entry.tag] === undefined,
      } };
    }),
    availableAgents: await Promise.all(AGENTS.map(async (id) => ({ id, label: LABELS[id], available: await agentPath(config, id) !== undefined }))),
  };
}

/** A complete pair is saved atomically; --reset restores inheritance. */
export async function editTagAgents(config: ProntoConfig, args: readonly string[]): Promise<ProntoConfig> {
  const [tagValue, ...flags] = args.filter((arg) => arg !== "--json");
  if (tagValue === undefined) throw new Error("Choose a tag: pronto tags agents <tag> --primary codex|claude --backup codex|claude|none, or --reset");
  const tag = normalizeTag(tagValue);
  // Check existence before probing executables or accepting options.
  setTagRuntimes(config, tag, null);
  if (flags.length === 1 && flags[0] === "--reset") return setTagRuntimes(config, tag, null);
  const options = new Map<string, string>();
  for (let index = 0; index < flags.length; index += 2) {
    const flag = flags[index]!;
    const value = flags[index + 1];
    if (!["--primary", "--backup"].includes(flag) || value === undefined || options.has(flag)) throw new Error("Specify --primary and --backup once each, or use --reset");
    options.set(flag, value);
  }
  const primary = options.get("--primary");
  const backup = options.get("--backup");
  if ((primary !== "codex" && primary !== "claude") || (backup !== "codex" && backup !== "claude" && backup !== "none")) {
    throw new Error("Default agent must be codex or claude; backup must be codex, claude, or none");
  }
  if (primary === backup) throw new Error("Backup agent must differ from the default agent");
  const resolve = async (kind: RuntimeKind) => {
    const path = await agentPath(config, kind);
    if (path === undefined) throw new Error(`${LABELS[kind]} is not installed. Install it before selecting it for a tag.`);
    return path;
  };
  const selection: RuntimeSelection = {
    primaryRuntime: primary,
    primaryRuntimePath: await resolve(primary),
    ...(backup === "none" ? {} : { fallbackRuntime: backup, fallbackRuntimePath: await resolve(backup) }),
  };
  return setTagRuntimes(config, tag, selection);
}
