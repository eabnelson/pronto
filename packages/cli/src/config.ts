import { chmod, lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import type { ChannelKind } from "./channels/types";

export const CONFIG_VERSION = 3 as const;
export const UNRESTRICTED_TRUST_VERSION = 1 as const;
/** Bumped when the WhatsApp disclosure changes materially, so setup asks again. */
export const WHATSAPP_RISK_CONSENT_VERSION = 1 as const;
export const TAG_PATTERN = /^@[A-Za-z0-9_-]{1,32}$/;

export type RuntimeKind = "codex" | "claude";

export interface ImessageChannelConfig {
  enabled: boolean;
  imsgPath: string;
  tags: string[];
}

export interface WhatsappChannelConfig {
  enabled: boolean;
  riskConsentVersion: typeof WHATSAPP_RISK_CONSENT_VERSION;
  tags: string[];
  wacliPath: string;
}

/** One entry per messaging app. Each app keeps its own trigger tags. */
export interface ChannelsConfig {
  imessage?: ImessageChannelConfig;
  whatsapp?: WhatsappChannelConfig;
}

export interface ProntoConfig {
  version: typeof CONFIG_VERSION;
  chatKeySalt: string;
  channels: ChannelsConfig;
  primaryRuntime: RuntimeKind;
  fallbackRuntime?: RuntimeKind;
  installedExecutableHash?: string;
  primaryRuntimePath?: string;
  fallbackRuntimePath?: string;
  workingDirectory: string;
  unrestrictedTrustVersion: typeof UNRESTRICTED_TRUST_VERSION;
}

export type ConfigInput = Omit<
  ProntoConfig,
  "channels" | "chatKeySalt" | "version"
> & {
  channels: {
    imessage?: Omit<ImessageChannelConfig, "tags"> & { tags: readonly string[] };
    whatsapp?: Omit<WhatsappChannelConfig, "riskConsentVersion" | "tags"> & {
      riskConsentVersion: number;
      tags: readonly string[];
    };
  };
  chatKeySalt?: string;
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

function channelEntry(
  config: Pick<ProntoConfig, "channels">,
  kind: ChannelKind,
): { enabled: boolean; tags: string[] } | undefined {
  return (config.channels as Partial<Record<ChannelKind, { enabled: boolean; tags: string[] }>>)[kind];
}

export function enabledChannels(config: Pick<ProntoConfig, "channels">): ChannelKind[] {
  return (Object.keys(config.channels) as ChannelKind[])
    .filter((kind) => channelEntry(config, kind)?.enabled === true);
}

export function channelTags(config: Pick<ProntoConfig, "channels">, kind: ChannelKind): string[] {
  return channelEntry(config, kind)?.tags ?? [];
}

/** Every configured tag with the apps it applies to, in first-seen order. */
export function tagAssignments(
  config: Pick<ProntoConfig, "channels">,
): Array<{ apps: ChannelKind[]; tag: string }> {
  const assignments = new Map<string, ChannelKind[]>();
  for (const kind of Object.keys(config.channels) as ChannelKind[]) {
    for (const tag of channelTags(config, kind)) {
      assignments.set(tag, [...(assignments.get(tag) ?? []), kind]);
    }
  }
  return [...assignments].map(([tag, apps]) => ({ apps, tag }));
}

function withChannelTags(
  config: ProntoConfig,
  kind: ChannelKind,
  tags: string[],
): ProntoConfig {
  const channel = channelEntry(config, kind);
  if (channel === undefined) throw new Error(`Messaging app is not configured: ${kind}`);
  return { ...config, channels: { ...config.channels, [kind]: { ...channel, tags } } };
}

/** Adds a tag to each app in `apps`; apps that already have it are unchanged. */
export function addTagToApps(
  config: ProntoConfig,
  value: string,
  apps: readonly ChannelKind[],
): ProntoConfig {
  if (apps.length === 0) throw new Error("Choose at least one messaging app for the tag");
  return apps.reduce(
    (next, kind) => withChannelTags(next, kind, addTag(channelTags(next, kind), value)),
    config,
  );
}

/** Removes a tag from each app in `apps` that has it; refuses to leave an app with no tags. */
export function removeTagFromApps(
  config: ProntoConfig,
  value: string,
  apps: readonly ChannelKind[],
): ProntoConfig {
  const tag = normalizeTag(value);
  const holders = apps.filter((kind) => channelTags(config, kind).includes(tag));
  if (holders.length === 0) throw new Error(`Tag is not configured: ${tag}`);
  return holders.reduce(
    (next, kind) => withChannelTags(next, kind, removeTag(channelTags(next, kind), tag)),
    config,
  );
}

export function createConfig(input: ConfigInput): ProntoConfig {
  if (input.unrestrictedTrustVersion !== UNRESTRICTED_TRUST_VERSION) {
    throw new Error("Unrestricted access consent is missing; run pronto setup");
  }
  if (input.fallbackRuntime === input.primaryRuntime) {
    throw new Error("Fallback runtime must differ from the primary runtime");
  }
  if (!isAbsolute(input.workingDirectory)) {
    throw new Error("Working directory must be absolute");
  }
  const channels: ChannelsConfig = {};
  const imessage = input.channels.imessage;
  if (imessage !== undefined) {
    if (!isAbsolute(imessage.imsgPath)) throw new Error("imsg path must be absolute");
    channels.imessage = {
      enabled: imessage.enabled,
      imsgPath: imessage.imsgPath,
      tags: normalizeTags(imessage.tags),
    };
  }
  const whatsapp = input.channels.whatsapp;
  if (whatsapp !== undefined) {
    if (!isAbsolute(whatsapp.wacliPath)) throw new Error("wacli path must be absolute");
    if (whatsapp.riskConsentVersion !== WHATSAPP_RISK_CONSENT_VERSION) {
      throw new Error("WhatsApp risk consent is missing; run pronto setup");
    }
    channels.whatsapp = {
      enabled: whatsapp.enabled,
      riskConsentVersion: WHATSAPP_RISK_CONSENT_VERSION,
      tags: normalizeTags(whatsapp.tags),
      wacliPath: whatsapp.wacliPath,
    };
  }
  if (enabledChannels({ channels }).length === 0) {
    throw new Error("Enable at least one messaging app");
  }

  return {
    ...input,
    channels,
    chatKeySalt: input.chatKeySalt ?? randomBytes(32).toString("base64url"),
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

export async function saveConfig(path: string, config: ProntoConfig): Promise<void> {
  await atomicWritePrivate(path, `${JSON.stringify(config, null, 2)}\n`);
}

function isRuntime(value: unknown): value is RuntimeKind {
  return value === "codex" || value === "claude";
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
  const channels = value.version === CONFIG_VERSION
    ? parseChannels(value.channels)
    : legacyChannels(value);
  if (typeof value.workingDirectory !== "string") throw new Error("Invalid working directory");
  if (value.unrestrictedTrustVersion !== UNRESTRICTED_TRUST_VERSION) {
    throw new Error("Unrestricted access consent is missing; run pronto setup");
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
    channels,
    chatKeySalt: value.chatKeySalt,
    primaryRuntime: value.primaryRuntime,
    workingDirectory: value.workingDirectory,
    unrestrictedTrustVersion: value.unrestrictedTrustVersion,
  });
}

function stringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : null;
}

// Versions 1 and 2 were iMessage-only with global tags.
function legacyChannels(value: Record<string, unknown>): ConfigInput["channels"] {
  if (typeof value.imsgPath !== "string") throw new Error("Invalid configuration fields");
  const tags = value.version === 1
    ? typeof value.tag === "string" ? [value.tag] : null
    : stringArray(value.tags);
  if (tags === null) throw new Error("Invalid configuration tags");
  return { imessage: { enabled: true, imsgPath: value.imsgPath, tags } };
}

function parseChannels(raw: unknown): ConfigInput["channels"] {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Invalid configuration channels");
  }
  const channels: ConfigInput["channels"] = {};
  for (const [kind, entry] of Object.entries(raw)) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("Invalid configuration channels");
    }
    const channel = entry as Record<string, unknown>;
    const tags = stringArray(channel.tags);
    if (kind === "imessage") {
      if (typeof channel.enabled !== "boolean" || typeof channel.imsgPath !== "string" || tags === null) {
        throw new Error("Invalid iMessage configuration");
      }
      channels.imessage = { enabled: channel.enabled, imsgPath: channel.imsgPath, tags };
    } else if (kind === "whatsapp") {
      if (
        typeof channel.enabled !== "boolean" || typeof channel.wacliPath !== "string" ||
        typeof channel.riskConsentVersion !== "number" || tags === null
      ) {
        throw new Error("Invalid WhatsApp configuration");
      }
      channels.whatsapp = {
        enabled: channel.enabled,
        riskConsentVersion: channel.riskConsentVersion,
        tags,
        wacliPath: channel.wacliPath,
      };
    } else {
      throw new Error(`Unsupported messaging app in configuration: ${kind}`);
    }
  }
  return channels;
}
