import { createHash, createPublicKey, randomUUID, verify as verifySignature } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ensurePrivateDirectory } from "./config";
import type { ProntoPaths } from "./macos/paths";
import { PRONTO_SIGNING_TEAM_IDENTIFIER } from "./macos/release-identity";
import { runCommand, type CommandRunner } from "./macos/setup";
import {
  PRONTO_UPDATE_KEY_ID,
  PRONTO_UPDATE_PUBLIC_KEY_SPKI_DER_BASE64,
  compareVersions,
  releaseSequenceForVersion,
} from "./update";

export const MENUBAR_BUNDLE_IDENTIFIER = "dev.pronto.menubar";
export const MENUBAR_ARCHIVE_NAME = "Pronto-menubar.zip";
export const MENUBAR_MANIFEST_NAME = "pronto-menubar-update.json";
export const MENUBAR_MANIFEST_URL =
  `https://github.com/eabnelson/pronto/releases/latest/download/${MENUBAR_MANIFEST_NAME}`;
const MAX_ENVELOPE_BYTES = 64 * 1_024;
const MAX_ARCHIVE_BYTES = 128 * 1_024 * 1_024;
const DOWNLOAD_TIMEOUT_MS = 60_000;

/**
 * The menu bar app ships in the same signed release as the executable, under its own
 * manifest: older updaters reject unknown manifest fields, so it cannot join pronto-update.json.
 */
export interface MenubarManifest {
  readonly artifact: {
    readonly macosSigning: { readonly identifier: string; readonly teamIdentifier: string };
    readonly sha256: string;
    readonly size: number;
    readonly url: string;
  };
  readonly channel: "stable";
  readonly expiresAt: string;
  readonly product: "pronto-menubar";
  readonly publishedAt: string;
  readonly releaseSequence: number;
  readonly schemaVersion: 1;
  readonly sourceRevision: string;
  readonly version: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

export function menubarRequirement(): string {
  return `identifier "${MENUBAR_BUNDLE_IDENTIFIER}" and anchor apple generic and certificate leaf[subject.OU] = "${PRONTO_SIGNING_TEAM_IDENTIFIER}"`;
}

export function verifyMenubarEnvelope(
  encoded: Uint8Array,
  now = new Date(),
  publicKeySpkiDerBase64 = PRONTO_UPDATE_PUBLIC_KEY_SPKI_DER_BASE64,
): MenubarManifest {
  if (encoded.byteLength > MAX_ENVELOPE_BYTES) throw new Error("menubar_envelope_too_large");
  let envelope: unknown;
  try {
    envelope = JSON.parse(new TextDecoder().decode(encoded));
  } catch {
    throw new Error("menubar_envelope_invalid");
  }
  if (
    !isRecord(envelope) || !exactKeys(envelope, ["keyId", "payload", "signature"]) ||
    envelope.keyId !== PRONTO_UPDATE_KEY_ID ||
    typeof envelope.payload !== "string" || typeof envelope.signature !== "string"
  ) {
    throw new Error("menubar_envelope_invalid");
  }
  const payloadBytes = Buffer.from(envelope.payload, "base64url");
  const publicKey = createPublicKey({
    format: "der",
    key: Buffer.from(publicKeySpkiDerBase64, "base64"),
    type: "spki",
  });
  if (!verifySignature(null, payloadBytes, publicKey, Buffer.from(envelope.signature, "base64url"))) {
    throw new Error("menubar_signature_invalid");
  }
  let payload: unknown;
  try {
    payload = JSON.parse(payloadBytes.toString("utf8"));
  } catch {
    throw new Error("menubar_payload_invalid");
  }
  if (
    !isRecord(payload) ||
    !exactKeys(payload, [
      "artifact", "channel", "expiresAt", "product", "publishedAt", "releaseSequence",
      "schemaVersion", "sourceRevision", "version",
    ]) ||
    payload.schemaVersion !== 1 || payload.product !== "pronto-menubar" || payload.channel !== "stable" ||
    typeof payload.version !== "string" ||
    payload.releaseSequence !== releaseSequenceForVersion(payload.version) ||
    typeof payload.publishedAt !== "string" || typeof payload.expiresAt !== "string" ||
    typeof payload.sourceRevision !== "string" || !/^[a-f0-9]{40}$/.test(payload.sourceRevision) ||
    !isRecord(payload.artifact)
  ) {
    throw new Error("menubar_payload_invalid");
  }
  const artifact = payload.artifact;
  if (
    !exactKeys(artifact, ["macosSigning", "sha256", "size", "url"]) ||
    typeof artifact.url !== "string" || typeof artifact.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(artifact.sha256) ||
    !Number.isSafeInteger(artifact.size) || (artifact.size as number) <= 0 ||
    (artifact.size as number) > MAX_ARCHIVE_BYTES ||
    !isRecord(artifact.macosSigning) ||
    !exactKeys(artifact.macosSigning, ["identifier", "teamIdentifier"]) ||
    artifact.macosSigning.identifier !== MENUBAR_BUNDLE_IDENTIFIER ||
    artifact.macosSigning.teamIdentifier !== PRONTO_SIGNING_TEAM_IDENTIFIER
  ) {
    throw new Error("menubar_artifact_invalid");
  }
  const url = new URL(artifact.url);
  if (
    url.protocol !== "https:" || url.hostname !== "github.com" ||
    url.pathname !== `/eabnelson/pronto/releases/download/v${payload.version}/${MENUBAR_ARCHIVE_NAME}`
  ) {
    throw new Error("menubar_artifact_origin_invalid");
  }
  const publishedAt = Date.parse(payload.publishedAt);
  const expiresAt = Date.parse(payload.expiresAt);
  if (
    !Number.isFinite(publishedAt) || !Number.isFinite(expiresAt) ||
    publishedAt > now.getTime() + 5 * 60_000 || expiresAt <= now.getTime() || expiresAt <= publishedAt
  ) {
    throw new Error("menubar_manifest_expired");
  }
  return payload as unknown as MenubarManifest;
}

export interface MenubarDependencies {
  readonly fetch: (url: string, init: RequestInit) => Promise<Response>;
  readonly now: () => Date;
  readonly randomId: () => string;
  readonly run: CommandRunner;
  readonly verifyEnvelope: (encoded: Uint8Array, now: Date) => MenubarManifest;
}

const defaultDependencies: MenubarDependencies = {
  fetch: (url, init) => globalThis.fetch(url, init),
  now: () => new Date(),
  randomId: randomUUID,
  run: runCommand,
  verifyEnvelope: verifyMenubarEnvelope,
};

export type MenubarStatus =
  | { readonly status: "not_installed"; readonly version?: string }
  | { readonly installedVersion: string; readonly status: "current" }
  | { readonly installedVersion: string | null; readonly status: "available"; readonly version: string };

export type MenubarInstall =
  | { readonly status: "current" | "installed"; readonly version: string }
  | { readonly status: "not_installed" };

async function download(response: Response, size: number): Promise<Uint8Array> {
  if (!response.ok) throw new Error(`menubar_download_failed:${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength !== size) throw new Error("menubar_artifact_size_mismatch");
  return bytes;
}

/** Installs and updates `~/Applications/Pronto.app` from the signed release. */
export class MenubarInstaller {
  readonly #dependencies: MenubarDependencies;

  constructor(
    readonly paths: Pick<ProntoPaths, "menubarAppPath" | "updateDirectory">,
    dependencies: Partial<MenubarDependencies> = {},
  ) {
    this.#dependencies = { ...defaultDependencies, ...dependencies };
  }

  async installedVersion(appPath = this.paths.menubarAppPath): Promise<string | null> {
    if (!existsSync(appPath)) return null;
    const result = await this.#dependencies.run("/usr/bin/plutil", [
      "-extract", "CFBundleShortVersionString", "raw", "-o", "-", join(appPath, "Contents", "Info.plist"),
    ]);
    const version = result.stdout.trim();
    return result.exitCode === 0 && /^\d+\.\d+\.\d+$/.test(version) ? version : null;
  }

  async #manifest(): Promise<MenubarManifest> {
    const response = await this.#dependencies.fetch(MENUBAR_MANIFEST_URL, {
      headers: { accept: "application/json" },
      redirect: "follow",
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`menubar_manifest_unavailable:${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    return this.#dependencies.verifyEnvelope(bytes, this.#dependencies.now());
  }

  async check(): Promise<MenubarStatus> {
    const installedVersion = await this.installedVersion();
    const manifest = await this.#manifest();
    if (installedVersion === null) return { status: "not_installed", version: manifest.version };
    if (compareVersions(manifest.version, installedVersion) <= 0) {
      return { installedVersion, status: "current" };
    }
    return { installedVersion, status: "available", version: manifest.version };
  }

  /** Installs or updates the app. With `onlyIfInstalled`, a missing app is left missing. */
  async install(options: { readonly onlyIfInstalled?: boolean } = {}): Promise<MenubarInstall> {
    const installedVersion = await this.installedVersion();
    if (installedVersion === null && options.onlyIfInstalled === true) return { status: "not_installed" };
    const manifest = await this.#manifest();
    if (installedVersion !== null && compareVersions(manifest.version, installedVersion) <= 0) {
      return { status: "current", version: installedVersion };
    }

    const response = await this.#dependencies.fetch(manifest.artifact.url, {
      headers: { accept: "application/octet-stream" },
      redirect: "follow",
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    const bytes = await download(response, manifest.artifact.size);
    if (createHash("sha256").update(bytes).digest("hex") !== manifest.artifact.sha256) {
      throw new Error("menubar_artifact_digest_mismatch");
    }

    await ensurePrivateDirectory(this.paths.updateDirectory);
    const staging = join(this.paths.updateDirectory, `.menubar-${this.#dependencies.randomId()}`);
    await ensurePrivateDirectory(staging);
    const target = this.paths.menubarAppPath;
    const backup = `${staging}/previous.app`;
    let replaced = false;
    try {
      const archive = join(staging, MENUBAR_ARCHIVE_NAME);
      await writeFile(archive, bytes, { mode: 0o600 });
      const extracted = join(staging, "extracted");
      const unpacked = await this.#dependencies.run("/usr/bin/ditto", ["-x", "-k", archive, extracted]);
      if (unpacked.exitCode !== 0) throw new Error("menubar_archive_invalid");
      const candidate = join(extracted, "Pronto.app");
      const signature = await this.#dependencies.run("/usr/bin/codesign", [
        "--verify", "--deep", "--strict", `-R=${menubarRequirement()}`, candidate,
      ]);
      if (signature.exitCode !== 0) throw new Error("menubar_signature_mismatch");
      if (await this.installedVersion(candidate) !== manifest.version) {
        throw new Error("menubar_version_mismatch");
      }

      const wasRunning = await this.#quitIfRunning();
      await mkdir(dirname(target), { recursive: true });
      if (existsSync(target)) await rename(target, backup);
      try {
        await rename(candidate, target);
        replaced = true;
      } catch (error) {
        if (existsSync(backup)) await rename(backup, target);
        throw error;
      }
      if (wasRunning) await this.#dependencies.run("/usr/bin/open", ["-b", MENUBAR_BUNDLE_IDENTIFIER]);
      return { status: "installed", version: manifest.version };
    } finally {
      if (!replaced && existsSync(backup) && !existsSync(target)) await rename(backup, target).catch(() => undefined);
      await rm(staging, { force: true, recursive: true });
    }
  }

  async uninstall(): Promise<void> {
    await this.#quitIfRunning();
    await rm(this.paths.menubarAppPath, { force: true, recursive: true });
  }

  async open(): Promise<void> {
    await this.#dependencies.run("/usr/bin/open", [this.paths.menubarAppPath]);
  }

  async #quitIfRunning(): Promise<boolean> {
    const running = await this.#dependencies.run("/usr/bin/pgrep", ["-f", `${this.paths.menubarAppPath}/Contents/MacOS/`]);
    if (running.exitCode !== 0) return false;
    await this.#dependencies.run("/usr/bin/osascript", [
      "-e", `tell application id "${MENUBAR_BUNDLE_IDENTIFIER}" to quit`,
    ]);
    return true;
  }
}
