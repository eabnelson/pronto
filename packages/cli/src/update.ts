import {
  createHash,
  createPublicKey,
  randomUUID,
  verify as verifySignature,
} from "node:crypto";
import {
  chmod,
  copyFile,
  open,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import packageJson from "../../../package.json" with { type: "json" };
import {
  atomicWritePrivate,
  ensurePrivateDirectory,
  loadConfig,
  saveConfig,
  type ProntoConfig,
} from "./config";
import {
  LAUNCH_AGENT_LABEL,
  type ProntoPaths,
} from "./macos/paths";
import {
  installLaunchAgent,
  installUpdaterLaunchAgent,
  renderLaunchAgent,
  renderUpdaterLaunchAgent,
  stopLaunchAgentForLabel,
} from "./macos/launch-agent";
import { runCommand, sha256File, type CommandRunner } from "./macos/setup";
import {
  inspectProntoExecutableIdentity,
  PRONTO_SIGNING_IDENTIFIER,
  PRONTO_SIGNING_TEAM_IDENTIFIER,
} from "./macos/release-identity";
export {
  inspectProntoExecutableIdentity,
  PRONTO_SIGNING_IDENTIFIER,
  PRONTO_SIGNING_TEAM_IDENTIFIER,
} from "./macos/release-identity";
export const PRONTO_UPDATE_KEY_ID = "pronto-release-v1";
export const PRONTO_UPDATE_MANIFEST_URL =
  "https://github.com/eabnelson/pronto/releases/latest/download/pronto-update.json";
export const PRONTO_UPDATE_PUBLIC_KEY_SPKI_DER_BASE64 =
  "MCowBQYDK2VwAyEAN/cWzdaYzwlR5qCKfu4BG5blHXBkd0Hp5mP8x05FrqI=";

const MAX_ENVELOPE_BYTES = 64 * 1_024;
const MAX_ARTIFACT_BYTES = 256 * 1_024 * 1_024;
const UPDATE_TIMEOUT_MS = 30_000;
// Allow multiple bounded catch-up attempts without accepting degraded as ready.
const QUALIFICATION_ATTEMPTS = 600;
const QUALIFICATION_INTERVAL_MS = 500;

export type ProntoUpdateTarget = "darwin-arm64" | "darwin-x64";

export interface ProntoUpdateArtifact {
  readonly url: string;
  readonly size: number;
  readonly sha256: string;
  readonly macosSigning: {
    readonly identifier: string;
    readonly teamIdentifier: string;
  };
}

export interface ProntoUpdateManifest {
  readonly schemaVersion: 1;
  readonly product: "pronto";
  readonly version: string;
  readonly releaseSequence: number;
  readonly channel: "stable";
  readonly publishedAt: string;
  readonly expiresAt: string;
  readonly sourceRevision: string;
  readonly minimumUpdaterVersion: string;
  readonly artifacts: Record<ProntoUpdateTarget, ProntoUpdateArtifact>;
}

export interface SignedProntoUpdateEnvelope {
  readonly keyId: string;
  readonly payload: string;
  readonly signature: string;
}

export interface ProntoUpdateState {
  readonly schemaVersion: 1;
  readonly highestReleaseSequence: number;
  readonly installedVersion: string;
  readonly updatedAt: string;
}

export type ProntoUpdateCheck =
  | { readonly status: "current"; readonly version: string }
  | { readonly status: "available"; readonly manifest: ProntoUpdateManifest };

export type ProntoUpdateInstall =
  | { readonly status: "current"; readonly version: string }
  | { readonly status: "installed"; readonly version: string }
  | { readonly status: "migration_required"; readonly version: string }
  | { readonly status: "migration_installed"; readonly version: string };

export interface ProntoUpdateDependencies {
  readonly currentVersion: string;
  readonly fetch: (url: string, init: RequestInit) => Promise<Response>;
  readonly now: () => Date;
  readonly randomId: () => string;
  readonly run: CommandRunner;
  readonly inspectIdentity: (
    path: string,
    run: CommandRunner,
  ) => Promise<{ readonly identifier: string; readonly teamIdentifier: string } | undefined>;
  readonly installMainAgent: (paths: ProntoPaths, config: ProntoConfig) => Promise<void>;
  readonly installUpdaterAgent: (paths: ProntoPaths) => Promise<void>;
  readonly stopAgent: () => Promise<void>;
  readonly verifyEnvelope: (encoded: Uint8Array, now: Date) => ProntoUpdateManifest;
  readonly wait: (milliseconds: number) => Promise<void>;
}

const defaultDependencies: ProntoUpdateDependencies = {
  currentVersion: packageJson.version,
  fetch: (url, init) => globalThis.fetch(url, init),
  now: () => new Date(),
  randomId: randomUUID,
  run: runCommand,
  inspectIdentity: inspectProntoExecutableIdentity,
  installMainAgent: async (paths, config) => await installLaunchAgent({
    plist: renderLaunchAgent({
      executablePath: paths.executablePath,
      logPath: paths.logPath,
      runtimeExecutablePaths: [
        config.primaryRuntimePath,
        config.fallbackRuntimePath,
      ].filter((path): path is string => path !== undefined),
    }),
    plistPath: paths.launchAgentPath,
  }),
  installUpdaterAgent: async (paths) => await installUpdaterLaunchAgent({
    plist: renderUpdaterLaunchAgent({
      executablePath: paths.executablePath,
      logPath: paths.logPath,
    }),
    plistPath: paths.updaterLaunchAgentPath,
  }),
  stopAgent: async () => await stopLaunchAgentForLabel({ label: LAUNCH_AGENT_LABEL }),
  verifyEnvelope: verifyProntoUpdateEnvelope,
  wait: Bun.sleep,
};

export function releaseSequenceForVersion(version: string): number {
  const parsed = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (parsed === null) throw new Error("update_version_invalid");
  const [major, minor, patch] = parsed.slice(1).map(Number) as [number, number, number];
  if (major > 8_000 || minor > 999 || patch > 999) {
    throw new Error("update_version_out_of_range");
  }
  return major * 1_000_000_000 + minor * 1_000_000 + patch * 1_000 + 999;
}

export function compareVersions(left: string, right: string): number {
  return releaseSequenceForVersion(left) - releaseSequenceForVersion(right);
}

export function updateTarget(
  platform: NodeJS.Platform = process.platform,
  architecture: string = process.arch,
): ProntoUpdateTarget {
  if (platform !== "darwin") throw new Error("update_platform_unsupported");
  if (architecture === "arm64") return "darwin-arm64";
  if (architecture === "x64") return "darwin-x64";
  throw new Error("update_architecture_unsupported");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && actual.every((key, index) => key === [...keys].sort()[index]);
}

function validIsoDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function parseArtifact(value: unknown, version: string, target: ProntoUpdateTarget): ProntoUpdateArtifact {
  if (!isRecord(value) || !exactKeys(value, ["macosSigning", "sha256", "size", "url"])) {
    throw new Error("update_artifact_invalid");
  }
  if (
    typeof value.url !== "string" ||
    !Number.isSafeInteger(value.size) ||
    (value.size as number) <= 0 ||
    (value.size as number) > MAX_ARTIFACT_BYTES ||
    typeof value.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.sha256) ||
    !isRecord(value.macosSigning) ||
    !exactKeys(value.macosSigning, ["identifier", "teamIdentifier"]) ||
    value.macosSigning.identifier !== PRONTO_SIGNING_IDENTIFIER ||
    value.macosSigning.teamIdentifier !== PRONTO_SIGNING_TEAM_IDENTIFIER
  ) {
    throw new Error("update_artifact_invalid");
  }
  const url = new URL(value.url);
  const expectedPath = `/eabnelson/pronto/releases/download/v${version}/pronto-${target}`;
  if (url.protocol !== "https:" || url.hostname !== "github.com" || url.pathname !== expectedPath) {
    throw new Error("update_artifact_origin_invalid");
  }
  return {
    url: value.url,
    size: value.size as number,
    sha256: value.sha256,
    macosSigning: {
      identifier: PRONTO_SIGNING_IDENTIFIER,
      teamIdentifier: PRONTO_SIGNING_TEAM_IDENTIFIER,
    },
  };
}

export function verifyProntoUpdateEnvelope(
  encoded: Uint8Array,
  now = new Date(),
  publicKeySpkiDerBase64 = PRONTO_UPDATE_PUBLIC_KEY_SPKI_DER_BASE64,
): ProntoUpdateManifest {
  if (encoded.byteLength > MAX_ENVELOPE_BYTES) throw new Error("update_envelope_too_large");
  let envelopeValue: unknown;
  try {
    envelopeValue = JSON.parse(new TextDecoder().decode(encoded));
  } catch {
    throw new Error("update_envelope_invalid");
  }
  if (
    !isRecord(envelopeValue) ||
    !exactKeys(envelopeValue, ["keyId", "payload", "signature"]) ||
    envelopeValue.keyId !== PRONTO_UPDATE_KEY_ID ||
    typeof envelopeValue.payload !== "string" ||
    typeof envelopeValue.signature !== "string"
  ) {
    throw new Error("update_envelope_invalid");
  }
  const payloadBytes = Buffer.from(envelopeValue.payload, "base64url");
  const signatureBytes = Buffer.from(envelopeValue.signature, "base64url");
  const publicKey = createPublicKey({
    key: Buffer.from(publicKeySpkiDerBase64, "base64"),
    format: "der",
    type: "spki",
  });
  if (!verifySignature(null, payloadBytes, publicKey, signatureBytes)) {
    throw new Error("update_signature_invalid");
  }
  let payloadValue: unknown;
  try {
    payloadValue = JSON.parse(payloadBytes.toString("utf8"));
  } catch {
    throw new Error("update_payload_invalid");
  }
  const keys = [
    "artifacts",
    "channel",
    "expiresAt",
    "minimumUpdaterVersion",
    "product",
    "publishedAt",
    "releaseSequence",
    "schemaVersion",
    "sourceRevision",
    "version",
  ];
  if (!isRecord(payloadValue) || !exactKeys(payloadValue, keys)) {
    throw new Error("update_payload_invalid");
  }
  if (
    payloadValue.schemaVersion !== 1 ||
    payloadValue.product !== "pronto" ||
    payloadValue.channel !== "stable" ||
    typeof payloadValue.version !== "string" ||
    typeof payloadValue.minimumUpdaterVersion !== "string" ||
    !Number.isSafeInteger(payloadValue.releaseSequence) ||
    payloadValue.releaseSequence !== releaseSequenceForVersion(payloadValue.version) ||
    !validIsoDate(payloadValue.publishedAt) ||
    !validIsoDate(payloadValue.expiresAt) ||
    typeof payloadValue.sourceRevision !== "string" ||
    !/^[a-f0-9]{40}$/.test(payloadValue.sourceRevision) ||
    !isRecord(payloadValue.artifacts) ||
    !exactKeys(payloadValue.artifacts, ["darwin-arm64", "darwin-x64"])
  ) {
    throw new Error("update_payload_invalid");
  }
  releaseSequenceForVersion(payloadValue.minimumUpdaterVersion);
  const publishedAt = Date.parse(payloadValue.publishedAt);
  const expiresAt = Date.parse(payloadValue.expiresAt);
  if (publishedAt > now.getTime() + 5 * 60_000 || expiresAt <= now.getTime() || expiresAt <= publishedAt) {
    throw new Error("update_manifest_expired");
  }
  return {
    schemaVersion: 1,
    product: "pronto",
    version: payloadValue.version,
    releaseSequence: payloadValue.releaseSequence as number,
    channel: "stable",
    publishedAt: payloadValue.publishedAt,
    expiresAt: payloadValue.expiresAt,
    sourceRevision: payloadValue.sourceRevision,
    minimumUpdaterVersion: payloadValue.minimumUpdaterVersion,
    artifacts: {
      "darwin-arm64": parseArtifact(
        payloadValue.artifacts["darwin-arm64"],
        payloadValue.version,
        "darwin-arm64",
      ),
      "darwin-x64": parseArtifact(
        payloadValue.artifacts["darwin-x64"],
        payloadValue.version,
        "darwin-x64",
      ),
    },
  };
}

async function responseBytes(response: Response, maximum: number): Promise<Uint8Array> {
  if (!response.ok) throw new Error(`update_download_failed:${response.status}`);
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximum) throw new Error("update_download_too_large");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maximum) throw new Error("update_download_too_large");
  return bytes;
}

async function loadState(path: string): Promise<ProntoUpdateState | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (
      !isRecord(value) ||
      value.schemaVersion !== 1 ||
      !Number.isSafeInteger(value.highestReleaseSequence) ||
      typeof value.installedVersion !== "string" ||
      !validIsoDate(value.updatedAt)
    ) {
      throw new Error("update_state_invalid");
    }
    return value as unknown as ProntoUpdateState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function acquireLock(path: string): Promise<FileHandle> {
  await ensurePrivateDirectory(dirname(path));
  try {
    const handle = await open(path, "wx", 0o600);
    await handle.writeFile(`${process.pid}\n`);
    return handle;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      const details = await stat(path).catch(() => undefined);
      if (details !== undefined && Date.now() - details.mtimeMs > 2 * 60 * 60 * 1_000) {
        await unlink(path);
        const handle = await open(path, "wx", 0o600);
        await handle.writeFile(`${process.pid}\n`);
        return handle;
      }
      throw new Error("update_already_running");
    }
    throw error;
  }
}

export class ProntoUpdater {
  readonly #dependencies: ProntoUpdateDependencies;

  constructor(
    readonly paths: ProntoPaths,
    dependencies: Partial<ProntoUpdateDependencies> = {},
  ) {
    this.#dependencies = { ...defaultDependencies, ...dependencies };
  }

  async check(): Promise<ProntoUpdateCheck> {
    const response = await this.#dependencies.fetch(PRONTO_UPDATE_MANIFEST_URL, {
      headers: { accept: "application/json" },
      redirect: "follow",
      signal: AbortSignal.timeout(UPDATE_TIMEOUT_MS),
    });
    const manifest = this.#dependencies.verifyEnvelope(
      await responseBytes(response, MAX_ENVELOPE_BYTES),
      this.#dependencies.now(),
    );
    const state = await loadState(this.paths.updateStatePath);
    if (
      state !== undefined &&
      manifest.releaseSequence < state.highestReleaseSequence
    ) {
      throw new Error("update_manifest_replay");
    }
    if (compareVersions(this.#dependencies.currentVersion, manifest.minimumUpdaterVersion) < 0) {
      throw new Error("update_updater_incompatible");
    }
    if (compareVersions(manifest.version, this.#dependencies.currentVersion) <= 0) {
      return { status: "current", version: this.#dependencies.currentVersion };
    }
    return { status: "available", manifest };
  }

  async install(options: { readonly allowIdentityMigration?: boolean } = {}): Promise<ProntoUpdateInstall> {
    const lock = await acquireLock(this.paths.updateLockPath);
    let stagedPath: string | undefined;
    try {
      const check = await this.check();
      if (check.status === "current") return check;
      const manifest = check.manifest;
      const currentIdentity = await this.#dependencies.inspectIdentity(
        this.paths.executablePath,
        this.#dependencies.run,
      );
      if (currentIdentity === undefined && options.allowIdentityMigration !== true) {
        return { status: "migration_required", version: manifest.version };
      }

      const target = updateTarget();
      const artifact = manifest.artifacts[target];
      const response = await this.#dependencies.fetch(artifact.url, {
        headers: { accept: "application/octet-stream" },
        redirect: "follow",
        signal: AbortSignal.timeout(UPDATE_TIMEOUT_MS),
      });
      const bytes = await responseBytes(response, Math.min(MAX_ARTIFACT_BYTES, artifact.size));
      if (bytes.byteLength !== artifact.size) throw new Error("update_artifact_size_mismatch");
      const digest = createHash("sha256").update(bytes).digest("hex");
      if (digest !== artifact.sha256) throw new Error("update_artifact_digest_mismatch");

      await ensurePrivateDirectory(this.paths.updateDirectory);
      stagedPath = join(this.paths.updateDirectory, `.candidate-${this.#dependencies.randomId()}`);
      await writeFile(stagedPath, bytes, { mode: 0o700 });
      await chmod(stagedPath, 0o700);
      const identity = await this.#dependencies.inspectIdentity(stagedPath, this.#dependencies.run);
      if (
        identity?.identifier !== artifact.macosSigning.identifier ||
        identity.teamIdentifier !== artifact.macosSigning.teamIdentifier
      ) {
        throw new Error("update_artifact_identity_mismatch");
      }
      const version = await this.#dependencies.run(stagedPath, ["--version"]);
      if (version.exitCode !== 0 || version.stdout.trim() !== `pronto ${manifest.version}`) {
        throw new Error("update_artifact_version_mismatch");
      }

      const config = await loadConfig(this.paths.configPath);
      const backupPath = this.paths.updateBackupPath;
      await unlink(backupPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
      const migrated = currentIdentity === undefined;
      let previousAtBackup = false;
      let candidateAtInstalledPath = false;
      let qualificationFailedDuringMigration = false;
      try {
        await this.#dependencies.stopAgent();
        await rename(this.paths.executablePath, backupPath);
        previousAtBackup = true;
        await rename(stagedPath, this.paths.executablePath);
        candidateAtInstalledPath = true;
        stagedPath = undefined;
        await chmod(this.paths.executablePath, 0o700);
        await saveConfig(this.paths.configPath, {
          ...config,
          installedExecutableHash: await sha256File(this.paths.executablePath),
        });
        await this.#dependencies.installMainAgent(this.paths, config);

        let qualified = false;
        for (let attempt = 0; attempt < QUALIFICATION_ATTEMPTS; attempt += 1) {
          const status = await this.#dependencies.run(this.paths.executablePath, ["status", "--json"]);
          if (status.exitCode === 0) {
            qualified = true;
            break;
          }
          await this.#dependencies.wait(QUALIFICATION_INTERVAL_MS);
        }
        if (!qualified) {
          if (migrated) qualificationFailedDuringMigration = true;
          else throw new Error("update_candidate_qualification_failed");
        }
        await atomicWritePrivate(this.paths.updateStatePath, `${JSON.stringify({
          schemaVersion: 1,
          highestReleaseSequence: manifest.releaseSequence,
          installedVersion: manifest.version,
          updatedAt: this.#dependencies.now().toISOString(),
        } satisfies ProntoUpdateState, null, 2)}\n`);
      } catch (error) {
        if (migrated && qualificationFailedDuringMigration) {
          throw error;
        }
        const rollbackErrors: unknown[] = [];
        await this.#dependencies.stopAgent().catch((rollbackError) => {
          rollbackErrors.push(rollbackError);
        });
        const failedPath = join(this.paths.updateDirectory, `.failed-${this.#dependencies.randomId()}`);
        if (candidateAtInstalledPath) {
          await rename(this.paths.executablePath, failedPath).catch((rollbackError) => {
            rollbackErrors.push(rollbackError);
          });
        }
        if (previousAtBackup) {
          await rename(backupPath, this.paths.executablePath).catch((rollbackError) => {
            rollbackErrors.push(rollbackError);
          });
          await saveConfig(this.paths.configPath, config).catch((rollbackError) => {
            rollbackErrors.push(rollbackError);
          });
          await this.#dependencies.installMainAgent(this.paths, config).catch((rollbackError) => {
            rollbackErrors.push(rollbackError);
          });
        }
        await unlink(failedPath).catch(() => undefined);
        if (rollbackErrors.length > 0) {
          throw new AggregateError([error, ...rollbackErrors], "update_rollback_failed");
        }
        throw error;
      }
      return migrated && qualificationFailedDuringMigration
        ? { status: "migration_installed", version: manifest.version }
        : { status: "installed", version: manifest.version };
    } finally {
      await lock.close();
      await unlink(this.paths.updateLockPath).catch(() => undefined);
      if (stagedPath !== undefined) await unlink(stagedPath).catch(() => undefined);
    }
  }

  async migrateLocalCandidate(candidatePath: string): Promise<ProntoUpdateInstall> {
    const lock = await acquireLock(this.paths.updateLockPath);
    let stagedPath: string | undefined;
    try {
      const candidateIdentity = await this.#dependencies.inspectIdentity(
        candidatePath,
        this.#dependencies.run,
      );
      if (
        candidateIdentity?.identifier !== PRONTO_SIGNING_IDENTIFIER ||
        candidateIdentity.teamIdentifier !== PRONTO_SIGNING_TEAM_IDENTIFIER
      ) {
        throw new Error("update_migration_candidate_identity_invalid");
      }
      const candidateVersion = await this.#dependencies.run(candidatePath, ["--version"]);
      if (
        candidateVersion.exitCode !== 0 ||
        candidateVersion.stdout.trim() !== `pronto ${this.#dependencies.currentVersion}`
      ) {
        throw new Error("update_migration_candidate_version_invalid");
      }
      const installedVersion = await this.#dependencies.run(this.paths.executablePath, ["--version"]);
      const parsedInstalledVersion = /^pronto (\d+\.\d+\.\d+)$/.exec(
        installedVersion.stdout.trim(),
      )?.[1];
      if (
        installedVersion.exitCode !== 0 ||
        parsedInstalledVersion === undefined ||
        compareVersions(this.#dependencies.currentVersion, parsedInstalledVersion) < 0
      ) {
        throw new Error("update_migration_installed_version_invalid");
      }
      const existingIdentity = await this.#dependencies.inspectIdentity(
        this.paths.executablePath,
        this.#dependencies.run,
      );
      if (existingIdentity !== undefined) {
        return { status: "current", version: parsedInstalledVersion };
      }

      const config = await loadConfig(this.paths.configPath);
      await ensurePrivateDirectory(this.paths.updateDirectory);
      stagedPath = join(this.paths.updateDirectory, `.migration-${this.#dependencies.randomId()}`);
      await copyFile(candidatePath, stagedPath);
      await chmod(stagedPath, 0o700);
      const stagedIdentity = await this.#dependencies.inspectIdentity(
        stagedPath,
        this.#dependencies.run,
      );
      if (stagedIdentity === undefined) throw new Error("update_migration_copy_identity_invalid");

      await unlink(this.paths.updateBackupPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
      await this.#dependencies.stopAgent();
      await rename(this.paths.executablePath, this.paths.updateBackupPath);
      try {
        await rename(stagedPath, this.paths.executablePath);
        stagedPath = undefined;
        await saveConfig(this.paths.configPath, {
          ...config,
          installedExecutableHash: await sha256File(this.paths.executablePath),
        });
        await this.#dependencies.installUpdaterAgent(this.paths);
        await this.#dependencies.installMainAgent(this.paths, config);
        await atomicWritePrivate(this.paths.updateStatePath, `${JSON.stringify({
          schemaVersion: 1,
          highestReleaseSequence: releaseSequenceForVersion(this.#dependencies.currentVersion),
          installedVersion: this.#dependencies.currentVersion,
          updatedAt: this.#dependencies.now().toISOString(),
        } satisfies ProntoUpdateState, null, 2)}\n`);
      } catch (error) {
        await this.#dependencies.stopAgent().catch(() => undefined);
        const failedPath = join(
          this.paths.updateDirectory,
          `.failed-migration-${this.#dependencies.randomId()}`,
        );
        await rename(this.paths.executablePath, failedPath).catch(() => undefined);
        await rename(this.paths.updateBackupPath, this.paths.executablePath);
        await saveConfig(this.paths.configPath, config);
        await this.#dependencies.installMainAgent(this.paths, config);
        await unlink(failedPath).catch(() => undefined);
        throw error;
      }

      for (let attempt = 0; attempt < QUALIFICATION_ATTEMPTS; attempt += 1) {
        const status = await this.#dependencies.run(this.paths.executablePath, ["status", "--json"]);
        if (status.exitCode === 0) {
          return { status: "installed", version: this.#dependencies.currentVersion };
        }
        await this.#dependencies.wait(QUALIFICATION_INTERVAL_MS);
      }
      return { status: "migration_installed", version: this.#dependencies.currentVersion };
    } finally {
      await lock.close();
      await unlink(this.paths.updateLockPath).catch(() => undefined);
      if (stagedPath !== undefined) await unlink(stagedPath).catch(() => undefined);
    }
  }
}
