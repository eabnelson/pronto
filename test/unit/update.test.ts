import { afterEach, describe, expect, test } from "bun:test";
import {
  createHash,
  generateKeyPairSync,
  sign,
} from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PRONTO_SIGNING_IDENTIFIER,
  PRONTO_SIGNING_TEAM_IDENTIFIER,
  PRONTO_UPDATE_KEY_ID,
  ProntoUpdater,
  releaseSequenceForVersion,
  verifyProntoUpdateEnvelope,
  type ProntoUpdateManifest,
} from "../../packages/cli/src/update";
import {
  createConfig,
  loadConfig,
  saveConfig,
  UNRESTRICTED_TRUST_VERSION,
} from "../../packages/cli/src/config";
import { pathsForHome } from "../../packages/cli/src/macos/paths";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

function manifest(
  bytes = new TextEncoder().encode("signed candidate"),
  overrides: Partial<ProntoUpdateManifest> = {},
): ProntoUpdateManifest {
  const version = overrides.version ?? "0.3.0";
  const artifact = {
    url: `https://github.com/eabnelson/pronto/releases/download/v${version}/pronto-darwin-arm64`,
    size: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    macosSigning: {
      identifier: PRONTO_SIGNING_IDENTIFIER,
      teamIdentifier: PRONTO_SIGNING_TEAM_IDENTIFIER,
    },
  };
  return {
    schemaVersion: 1,
    product: "pronto",
    version,
    releaseSequence: releaseSequenceForVersion(version),
    channel: "stable",
    publishedAt: "2026-09-04T12:00:00.000Z",
    expiresAt: "2027-09-04T12:00:00.000Z",
    sourceRevision: "a".repeat(40),
    minimumUpdaterVersion: "0.2.4",
    artifacts: {
      "darwin-arm64": artifact,
      "darwin-x64": {
        ...artifact,
        url: `https://github.com/eabnelson/pronto/releases/download/v${version}/pronto-darwin-x64`,
      },
    },
    ...overrides,
  };
}

function signedEnvelope(payload: ProntoUpdateManifest): {
  bytes: Uint8Array;
  publicKey: string;
} {
  const keys = generateKeyPairSync("ed25519");
  const payloadBytes = Buffer.from(JSON.stringify(payload));
  const signature = sign(null, payloadBytes, keys.privateKey);
  const envelope = {
    keyId: PRONTO_UPDATE_KEY_ID,
    payload: payloadBytes.toString("base64url"),
    signature: signature.toString("base64url"),
  };
  return {
    bytes: new TextEncoder().encode(JSON.stringify(envelope)),
    publicKey: keys.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
  };
}

describe("Pronto update envelope", () => {
  test("authenticates and validates a bounded release manifest", () => {
    const signed = signedEnvelope(manifest());
    expect(verifyProntoUpdateEnvelope(
      signed.bytes,
      new Date("2026-09-05T12:00:00.000Z"),
      signed.publicKey,
    )).toMatchObject({
      product: "pronto",
      releaseSequence: releaseSequenceForVersion("0.3.0"),
      version: "0.3.0",
    });
  });

  test("rejects tampering, expiration, and foreign artifact origins", () => {
    const signed = signedEnvelope(manifest());
    const tampered = Uint8Array.from(signed.bytes);
    tampered[tampered.length - 2] = tampered[tampered.length - 2]! ^ 1;
    expect(() => verifyProntoUpdateEnvelope(
      tampered,
      new Date("2026-09-05T12:00:00.000Z"),
      signed.publicKey,
    )).toThrow();
    expect(() => verifyProntoUpdateEnvelope(
      signed.bytes,
      new Date("2028-09-05T12:00:00.000Z"),
      signed.publicKey,
    )).toThrow("update_manifest_expired");

    const foreign = manifest();
    foreign.artifacts["darwin-arm64"] = {
      ...foreign.artifacts["darwin-arm64"],
      url: "https://example.com/pronto",
    };
    const foreignSigned = signedEnvelope(foreign);
    expect(() => verifyProntoUpdateEnvelope(
      foreignSigned.bytes,
      new Date("2026-09-05T12:00:00.000Z"),
      foreignSigned.publicKey,
    )).toThrow("update_artifact_origin_invalid");
  });
});

describe("Pronto updater", () => {
  test("stages, verifies, atomically installs, and records a qualified update", async () => {
    const home = await mkdtemp(join(tmpdir(), "pronto-update-"));
    temporaryDirectories.push(home);
    const paths = pathsForHome(home);
    const candidate = new TextEncoder().encode("signed candidate");
    await mkdir(join(paths.appSupportDirectory, "bin"), { recursive: true });
    await writeFile(paths.executablePath, "previous", { mode: 0o700 });
    await chmod(paths.executablePath, 0o700);
    await saveConfig(paths.configPath, createConfig({
      imsgPath: "/usr/local/bin/imsg",
      installedExecutableHash: createHash("sha256").update("previous").digest("hex"),
      primaryRuntime: "codex",
      primaryRuntimePath: "/usr/local/bin/codex",
      tags: ["@pronto"],
      unrestrictedTrustVersion: UNRESTRICTED_TRUST_VERSION,
      workingDirectory: home,
    }));
    const available = manifest(candidate);
    const calls: string[] = [];
    let fetchCount = 0;
    const updater = new ProntoUpdater(paths, {
      currentVersion: "0.2.4",
      fetch: async () => {
        fetchCount += 1;
        return new Response(fetchCount === 1 ? "manifest" : candidate);
      },
      inspectIdentity: async () => ({
        identifier: PRONTO_SIGNING_IDENTIFIER,
        teamIdentifier: PRONTO_SIGNING_TEAM_IDENTIFIER,
      }),
      now: () => new Date("2026-09-05T12:00:00.000Z"),
      randomId: () => "test",
      restoreAgent: async () => { calls.push("restore"); },
      run: async (executable, args) => {
        if (args[0] === "--version") return { exitCode: 0, stderr: "", stdout: "pronto 0.3.0\n" };
        calls.push(`${executable}:${args.join(" ")}`);
        return { exitCode: 0, stderr: "", stdout: "{}" };
      },
      stopAgent: async () => { calls.push("stop"); },
      verifyEnvelope: () => available,
      wait: async () => undefined,
    });

    expect(await updater.install()).toEqual({ status: "installed", version: "0.3.0" });
    expect(await readFile(paths.executablePath, "utf8")).toBe("signed candidate");
    expect(await readFile(paths.updateBackupPath, "utf8")).toBe("previous");
    expect(JSON.parse(await readFile(paths.updateStatePath, "utf8"))).toMatchObject({
      highestReleaseSequence: releaseSequenceForVersion("0.3.0"),
      installedVersion: "0.3.0",
    });
    expect((await loadConfig(paths.configPath)).installedExecutableHash).toBe(
      createHash("sha256").update(candidate).digest("hex"),
    );
    expect(calls[0]).toBe("stop");
    expect(calls).toContain("restore");
    expect((await stat(paths.executablePath)).mode & 0o777).toBe(0o700);
  });

  test("requires an explicit one-time migration from an ad-hoc install", async () => {
    const home = await mkdtemp(join(tmpdir(), "pronto-update-migration-"));
    temporaryDirectories.push(home);
    const paths = pathsForHome(home);
    const updater = new ProntoUpdater(paths, {
      currentVersion: "0.2.4",
      fetch: async () => new Response("manifest"),
      inspectIdentity: async () => undefined,
      verifyEnvelope: () => manifest(),
    });
    expect(await updater.install()).toEqual({
      status: "migration_required",
      version: "0.3.0",
    });
  });

  test("rolls back the executable and configuration when the candidate never becomes ready", async () => {
    const home = await mkdtemp(join(tmpdir(), "pronto-update-rollback-"));
    temporaryDirectories.push(home);
    const paths = pathsForHome(home);
    const candidate = new TextEncoder().encode("broken candidate");
    await mkdir(join(paths.appSupportDirectory, "bin"), { recursive: true });
    await writeFile(paths.executablePath, "known good", { mode: 0o700 });
    const originalHash = createHash("sha256").update("known good").digest("hex");
    await saveConfig(paths.configPath, createConfig({
      imsgPath: "/usr/local/bin/imsg",
      installedExecutableHash: originalHash,
      primaryRuntime: "codex",
      primaryRuntimePath: "/usr/local/bin/codex",
      tags: ["@pronto"],
      unrestrictedTrustVersion: UNRESTRICTED_TRUST_VERSION,
      workingDirectory: home,
    }));
    const available = manifest(candidate);
    let fetchCount = 0;
    let restores = 0;
    const updater = new ProntoUpdater(paths, {
      currentVersion: "0.2.4",
      fetch: async () => new Response(++fetchCount === 1 ? "manifest" : candidate),
      inspectIdentity: async () => ({
        identifier: PRONTO_SIGNING_IDENTIFIER,
        teamIdentifier: PRONTO_SIGNING_TEAM_IDENTIFIER,
      }),
      randomId: () => "rollback",
      restoreAgent: async () => { restores += 1; },
      run: async (_executable, args) => args[0] === "--version"
        ? { exitCode: 0, stderr: "", stdout: "pronto 0.3.0\n" }
        : { exitCode: 1, stderr: "not ready", stdout: "" },
      stopAgent: async () => undefined,
      verifyEnvelope: () => available,
      wait: async () => undefined,
    });

    await expect(updater.install()).rejects.toThrow("update_candidate_qualification_failed");
    expect(await readFile(paths.executablePath, "utf8")).toBe("known good");
    expect((await loadConfig(paths.configPath)).installedExecutableHash).toBe(originalHash);
    expect(restores).toBe(2);
  });

  test("migrates an existing ad-hoc install from a separately downloaded signed candidate", async () => {
    const home = await mkdtemp(join(tmpdir(), "pronto-update-local-migration-"));
    temporaryDirectories.push(home);
    const paths = pathsForHome(home);
    const candidatePath = join(home, "downloaded-pronto");
    await mkdir(join(paths.appSupportDirectory, "bin"), { recursive: true });
    await writeFile(paths.executablePath, "ad-hoc 0.2.4", { mode: 0o700 });
    await writeFile(candidatePath, "developer-id 0.3.0", { mode: 0o700 });
    await saveConfig(paths.configPath, createConfig({
      imsgPath: "/usr/local/bin/imsg",
      installedExecutableHash: createHash("sha256").update("ad-hoc 0.2.4").digest("hex"),
      primaryRuntime: "codex",
      primaryRuntimePath: "/usr/local/bin/codex",
      tags: ["@pronto"],
      unrestrictedTrustVersion: UNRESTRICTED_TRUST_VERSION,
      workingDirectory: home,
    }));
    let updaterInstalled = false;
    const updater = new ProntoUpdater(paths, {
      currentVersion: "0.3.0",
      inspectIdentity: async (path) => path === paths.executablePath
        ? undefined
        : {
            identifier: PRONTO_SIGNING_IDENTIFIER,
            teamIdentifier: PRONTO_SIGNING_TEAM_IDENTIFIER,
          },
      installUpdaterAgent: async () => { updaterInstalled = true; },
      randomId: () => "migration",
      restoreAgent: async () => undefined,
      run: async (executable, args) => {
        if (args[0] === "--version") {
          return {
            exitCode: 0,
            stderr: "",
            stdout: executable === paths.executablePath ? "pronto 0.2.4\n" : "pronto 0.3.0\n",
          };
        }
        return { exitCode: 1, stderr: "full disk access required", stdout: "" };
      },
      stopAgent: async () => undefined,
      wait: async () => undefined,
    });

    expect(await updater.migrateLocalCandidate(candidatePath)).toEqual({
      status: "migration_installed",
      version: "0.3.0",
    });
    expect(await readFile(paths.executablePath, "utf8")).toBe("developer-id 0.3.0");
    expect(await readFile(paths.updateBackupPath, "utf8")).toBe("ad-hoc 0.2.4");
    expect(updaterInstalled).toBeTrue();
    expect(JSON.parse(await readFile(paths.updateStatePath, "utf8"))).toMatchObject({
      installedVersion: "0.3.0",
    });
  });
});
