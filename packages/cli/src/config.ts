import { chmod, lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";

export const CONFIG_VERSION = 3 as const;
export const UNRESTRICTED_TRUST_VERSION = 1 as const;
export const TAG_PATTERN = /^@[A-Za-z0-9_-]{1,32}$/;

export type LocalRuntimeKind = "codex" | "claude";
export type RuntimeKind = LocalRuntimeKind | "conductor";
export type ConductorAgentKind = "acp" | "claude" | "codex" | "cursor";
export type ConductorEffort =
  | "none"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"
  | "ultra";

export interface ConductorConfig {
  agent: ConductorAgentKind;
  apiKey: string;
  branch?: string;
  effort?: ConductorEffort;
  fastMode?: boolean;
  model?: string;
  projectId: string;
  tag: string;
}

export interface ProntoConfig {
  version: typeof CONFIG_VERSION;
  chatKeySalt: string;
  tags: string[];
  primaryRuntime: LocalRuntimeKind;
  fallbackRuntime?: LocalRuntimeKind;
  conductor?: ConductorConfig;
  imsgPath: string;
  installedExecutableHash?: string;
  primaryRuntimePath?: string;
  fallbackRuntimePath?: string;
  workingDirectory: string;
  unrestrictedTrustVersion: typeof UNRESTRICTED_TRUST_VERSION;
}

export type ConfigInput = Omit<
  ProntoConfig,
  "chatKeySalt" | "tags" | "version"
> & {
  chatKeySalt?: string;
  tags: readonly string[];
};

export function normalizeTag(value: string): string {
  const input = value.trim();
  const tag = input.startsWith("@") ? input : `@${input}`;
  if (!TAG_PATTERN.test(tag)) {
    throw new Error("Tag must match @[A-Za-z0-9_-]{1,32}");
  }
  return tag.toLowerCase();
}

export function normalizeTags(values: readonly string[]): string[] {
  const tags = [...new Set(values.map(normalizeTag))];
  if (tags.length === 0) {
    throw new Error("Configure at least one tag");
  }
  return tags;
}

export function addTag(tags: readonly string[], value: string): string[] {
  return normalizeTags([...tags, value]);
}

export function removeTag(tags: readonly string[], value: string): string[] {
  const tag = normalizeTag(value);
  if (!tags.includes(tag)) throw new Error(`Tag is not configured: ${tag}`);
  if (tags.length === 1) {
    throw new Error("Cannot remove the last tag; add another tag first");
  }
  return tags.filter((candidate) => candidate !== tag);
}

export function createConfig(input: ConfigInput): ProntoConfig {
  if (input.unrestrictedTrustVersion !== UNRESTRICTED_TRUST_VERSION) {
    throw new Error("Unrestricted access consent is missing; run pronto setup");
  }
  if (input.fallbackRuntime === input.primaryRuntime) {
    throw new Error("Fallback runtime must differ from the primary runtime");
  }
  if (!isAbsolute(input.imsgPath)) throw new Error("imsg path must be absolute");
  if (!isAbsolute(input.workingDirectory)) {
    throw new Error("Working directory must be absolute");
  }
  const conductor = input.conductor === undefined
    ? undefined
    : normalizeConductorConfig(input.conductor);

  return {
    ...input,
    chatKeySalt: input.chatKeySalt ?? randomBytes(32).toString("base64url"),
    ...(conductor === undefined ? {} : { conductor }),
    tags: normalizeTags([
      ...input.tags,
      ...(conductor === undefined ? [] : [conductor.tag]),
    ]),
    version: CONFIG_VERSION,
  };
}

function safeConductorValue(value: string, label: string, maximum = 512): string {
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length > maximum ||
    /[\u0000-\u001f\u007f]/u.test(normalized)
  ) {
    throw new Error(`Invalid Conductor ${label}`);
  }
  return normalized;
}

export function normalizeConductorConfig(input: ConductorConfig): ConductorConfig {
  if (!["acp", "claude", "codex", "cursor"].includes(input.agent)) {
    throw new Error("Invalid Conductor agent");
  }
  if (
    input.effort !== undefined &&
    !["none", "low", "medium", "high", "xhigh", "max", "ultra"].includes(input.effort)
  ) {
    throw new Error("Invalid Conductor effort");
  }
  return {
    agent: input.agent,
    apiKey: safeConductorValue(input.apiKey, "API key", 4_096),
    ...(input.branch === undefined
      ? {}
      : { branch: safeConductorValue(input.branch, "branch", 1_024) }),
    ...(input.effort === undefined ? {} : { effort: input.effort }),
    ...(input.fastMode === undefined ? {} : { fastMode: input.fastMode }),
    ...(input.model === undefined
      ? {}
      : { model: safeConductorValue(input.model, "model", 256) }),
    projectId: safeConductorValue(input.projectId, "project ID", 256),
    tag: normalizeTag(input.tag),
  };
}

async function existingKind(path: string): Promise<"directory" | "missing" | "symlink" | "other"> {
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) return "symlink";
    if (stat.isDirectory()) return "directory";
    return "other";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
}

function allowedMacosSystemAlias(path: string): boolean {
  return process.platform === "darwin" && ["/etc", "/tmp", "/var"].includes(path);
}

export async function ensurePrivateDirectory(path: string): Promise<void> {
  const absolutePath = resolve(path);
  const root = parse(absolutePath).root;
  const components = absolutePath.slice(root.length).split("/").filter(Boolean);
  let current = root;

  for (const [index, component] of components.entries()) {
    current = join(current, component);
    const kind = await existingKind(current);
    if (kind === "symlink" && !allowedMacosSystemAlias(current)) {
      throw new Error(`Refusing symbolic link directory: ${current}`);
    }
    if (kind === "other") throw new Error(`Expected a directory: ${current}`);
    if (kind === "missing") await mkdir(current, { mode: 0o700 });
    if (index === components.length - 1) await chmod(current, 0o700);
  }
}

export async function atomicWritePrivate(path: string, contents: string): Promise<void> {
  const directory = dirname(path);
  await ensurePrivateDirectory(directory);
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, contents, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, path);
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
}

export async function saveConfig(path: string, config: ProntoConfig): Promise<void> {
  await atomicWritePrivate(path, `${JSON.stringify(config, null, 2)}\n`);
}

function isRuntime(value: unknown): value is LocalRuntimeKind {
  return value === "codex" || value === "claude";
}

function isConductorAgent(value: unknown): value is ConductorAgentKind {
  return value === "acp" || value === "claude" || value === "codex" || value === "cursor";
}

function isConductorEffort(value: unknown): value is ConductorEffort {
  return value === "none" || value === "low" || value === "medium" || value === "high" ||
    value === "xhigh" || value === "max" || value === "ultra";
}

function conductorConfig(value: unknown): ConductorConfig | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid Conductor configuration");
  }
  const candidate = value as Record<string, unknown>;
  if (
    !isConductorAgent(candidate.agent) ||
    typeof candidate.apiKey !== "string" ||
    typeof candidate.projectId !== "string" ||
    typeof candidate.tag !== "string" ||
    (candidate.branch !== undefined && typeof candidate.branch !== "string") ||
    (candidate.effort !== undefined && !isConductorEffort(candidate.effort)) ||
    (candidate.fastMode !== undefined && typeof candidate.fastMode !== "boolean") ||
    (candidate.model !== undefined && typeof candidate.model !== "string")
  ) {
    throw new Error("Invalid Conductor configuration");
  }
  return normalizeConductorConfig({
    agent: candidate.agent,
    apiKey: candidate.apiKey,
    ...(candidate.branch === undefined ? {} : { branch: candidate.branch }),
    ...(candidate.effort === undefined ? {} : { effort: candidate.effort }),
    ...(candidate.fastMode === undefined ? {} : { fastMode: candidate.fastMode }),
    ...(candidate.model === undefined ? {} : { model: candidate.model }),
    projectId: candidate.projectId,
    tag: candidate.tag,
  });
}

export async function loadConfig(path: string): Promise<ProntoConfig> {
  const raw: unknown = JSON.parse(await readFile(path, "utf8"));
  if (raw === null || typeof raw !== "object") throw new Error("Invalid configuration");
  const value = raw as Record<string, unknown>;
  if (value.version !== 1 && value.version !== 2 && value.version !== CONFIG_VERSION) {
    throw new Error("Unsupported configuration version");
  }
  if (!isRuntime(value.primaryRuntime)) throw new Error("Invalid primary runtime");
  if (value.fallbackRuntime !== undefined && !isRuntime(value.fallbackRuntime)) {
    throw new Error("Invalid fallback runtime");
  }
  if (typeof value.imsgPath !== "string") {
    throw new Error("Invalid configuration fields");
  }
  const tags = value.version === 1
    ? typeof value.tag === "string" ? [value.tag] : null
    : Array.isArray(value.tags) && value.tags.every((tag) => typeof tag === "string")
      ? value.tags
      : null;
  if (tags === null) throw new Error("Invalid configuration tags");
  if (typeof value.workingDirectory !== "string") throw new Error("Invalid working directory");
  if (value.unrestrictedTrustVersion !== UNRESTRICTED_TRUST_VERSION) {
    throw new Error("Unrestricted access consent is missing; run pronto setup");
  }
  if (typeof value.chatKeySalt !== "string" || value.chatKeySalt.length < 32) {
    throw new Error("Invalid chat-key salt");
  }

  return createConfig({
    ...(value.version === CONFIG_VERSION && value.conductor !== undefined
      ? { conductor: conductorConfig(value.conductor)! }
      : {}),
    ...(value.fallbackRuntime === undefined
      ? {}
      : { fallbackRuntime: value.fallbackRuntime }),
    ...(typeof value.primaryRuntimePath === "string"
      ? { primaryRuntimePath: value.primaryRuntimePath }
      : {}),
    ...(typeof value.installedExecutableHash === "string"
      ? { installedExecutableHash: value.installedExecutableHash }
      : {}),
    ...(typeof value.fallbackRuntimePath === "string"
      ? { fallbackRuntimePath: value.fallbackRuntimePath }
      : {}),
    imsgPath: value.imsgPath,
    chatKeySalt: value.chatKeySalt,
    primaryRuntime: value.primaryRuntime,
    tags,
    workingDirectory: value.workingDirectory,
    unrestrictedTrustVersion: value.unrestrictedTrustVersion,
  });
}
