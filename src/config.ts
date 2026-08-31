import { chmod, lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";

export const CONFIG_VERSION = 2 as const;
export const UNRESTRICTED_TRUST_VERSION = 1 as const;
export const TAG_PATTERN = /^@[A-Za-z0-9_-]{1,32}$/;

export type RuntimeKind = "codex" | "claude";

export interface S4imsgConfig {
  version: typeof CONFIG_VERSION;
  chatKeySalt: string;
  tags: string[];
  primaryRuntime: RuntimeKind;
  fallbackRuntime?: RuntimeKind;
  imsgPath: string;
  installedExecutableHash?: string;
  primaryRuntimePath?: string;
  fallbackRuntimePath?: string;
  workingDirectory: string;
  unrestrictedTrustVersion: typeof UNRESTRICTED_TRUST_VERSION;
}

export type ConfigInput = Omit<
  S4imsgConfig,
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

export function createConfig(input: ConfigInput): S4imsgConfig {
  if (input.unrestrictedTrustVersion !== UNRESTRICTED_TRUST_VERSION) {
    throw new Error("Unrestricted access consent is missing; run s4imsg setup");
  }
  if (input.fallbackRuntime === input.primaryRuntime) {
    throw new Error("Fallback runtime must differ from the primary runtime");
  }
  if (!isAbsolute(input.imsgPath)) throw new Error("imsg path must be absolute");
  if (!isAbsolute(input.workingDirectory)) {
    throw new Error("Working directory must be absolute");
  }

  return {
    ...input,
    chatKeySalt: input.chatKeySalt ?? randomBytes(32).toString("base64url"),
    tags: normalizeTags(input.tags),
    version: CONFIG_VERSION,
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

export async function saveConfig(path: string, config: S4imsgConfig): Promise<void> {
  await atomicWritePrivate(path, `${JSON.stringify(config, null, 2)}\n`);
}

function isRuntime(value: unknown): value is RuntimeKind {
  return value === "codex" || value === "claude";
}

export async function loadConfig(path: string): Promise<S4imsgConfig> {
  const raw: unknown = JSON.parse(await readFile(path, "utf8"));
  if (raw === null || typeof raw !== "object") throw new Error("Invalid configuration");
  const value = raw as Record<string, unknown>;
  if (value.version !== 1 && value.version !== CONFIG_VERSION) {
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
    throw new Error("Unrestricted access consent is missing; run s4imsg setup");
  }
  if (typeof value.chatKeySalt !== "string" || value.chatKeySalt.length < 32) {
    throw new Error("Invalid chat-key salt");
  }

  return createConfig({
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
