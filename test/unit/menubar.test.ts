import { afterEach, describe, expect, test } from "bun:test";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MENUBAR_ARCHIVE_NAME,
  MENUBAR_BUNDLE_IDENTIFIER,
  MenubarInstaller,
  verifyMenubarEnvelope,
  type MenubarManifest,
} from "../../packages/cli/src/menubar";
import { PRONTO_SIGNING_TEAM_IDENTIFIER } from "../../packages/cli/src/macos/release-identity";
import { PRONTO_UPDATE_KEY_ID, releaseSequenceForVersion } from "../../packages/cli/src/update";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

const archive = new TextEncoder().encode("zipped Pronto.app");

function manifest(overrides: Partial<MenubarManifest> = {}): MenubarManifest {
  const version = overrides.version ?? "0.5.0";
  return {
    artifact: {
      macosSigning: { identifier: MENUBAR_BUNDLE_IDENTIFIER, teamIdentifier: PRONTO_SIGNING_TEAM_IDENTIFIER },
      sha256: createHash("sha256").update(archive).digest("hex"),
      size: archive.byteLength,
      url: `https://github.com/eabnelson/pronto/releases/download/v${version}/${MENUBAR_ARCHIVE_NAME}`,
    },
    channel: "stable",
    expiresAt: "2027-09-04T12:00:00.000Z",
    product: "pronto-menubar",
    publishedAt: "2026-09-04T12:00:00.000Z",
    releaseSequence: releaseSequenceForVersion(version),
    schemaVersion: 1,
    sourceRevision: "a".repeat(40),
    version,
    ...overrides,
  };
}

function signed(payload: unknown): { bytes: Uint8Array; publicKey: string } {
  const keys = generateKeyPairSync("ed25519");
  const payloadBytes = Buffer.from(JSON.stringify(payload));
  return {
    bytes: new TextEncoder().encode(JSON.stringify({
      keyId: PRONTO_UPDATE_KEY_ID,
      payload: payloadBytes.toString("base64url"),
      signature: sign(null, payloadBytes, keys.privateKey).toString("base64url"),
    })),
    publicKey: keys.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
  };
}

describe("menu bar manifest", () => {
  const now = new Date("2026-09-05T12:00:00.000Z");

  test("authenticates a release-signed menu bar manifest", () => {
    const envelope = signed(manifest());
    expect(verifyMenubarEnvelope(envelope.bytes, now, envelope.publicKey).version).toBe("0.5.0");
  });

  test("rejects foreign signatures, other products, identities, and origins", () => {
    const good = signed(manifest());
    expect(() => verifyMenubarEnvelope(good.bytes, now, signed(manifest()).publicKey))
      .toThrow("menubar_signature_invalid");
    for (const [payload, error] of [
      [{ ...manifest(), product: "pronto" }, "menubar_payload_invalid"],
      [{ ...manifest(), extra: true }, "menubar_payload_invalid"],
      [manifest({ artifact: { ...manifest().artifact, macosSigning: { identifier: "dev.pronto.cli", teamIdentifier: PRONTO_SIGNING_TEAM_IDENTIFIER } } }), "menubar_artifact_invalid"],
      [manifest({ artifact: { ...manifest().artifact, url: "https://example.com/Pronto-menubar.zip" } }), "menubar_artifact_origin_invalid"],
      [manifest({ expiresAt: "2026-09-05T00:00:00.000Z" }), "menubar_manifest_expired"],
    ] as const) {
      const envelope = signed(payload);
      expect(() => verifyMenubarEnvelope(envelope.bytes, now, envelope.publicKey)).toThrow(error);
    }
  });
});

async function harness(options: { installedVersion?: string; signatureValid?: boolean; archiveBytes?: Uint8Array } = {}) {
  const home = await mkdtemp(join(tmpdir(), "pronto-menubar-"));
  temporaryDirectories.push(home);
  const paths = {
    menubarAppPath: join(home, "Applications", "Pronto.app"),
    updateDirectory: join(home, "updates"),
  };
  const writeApp = async (path: string, version: string) => {
    await mkdir(join(path, "Contents"), { recursive: true });
    await writeFile(join(path, "Contents", "Info.plist"), version);
  };
  if (options.installedVersion !== undefined) await writeApp(paths.menubarAppPath, options.installedVersion);
  const calls: string[][] = [];
  const installer = new MenubarInstaller(paths, {
    fetch: async (url) => new Response(url.endsWith(".json") ? "manifest" : options.archiveBytes ?? archive),
    randomId: () => "test",
    run: async (executable, args) => {
      calls.push([executable, ...args]);
      if (executable === "/usr/bin/plutil") {
        const plist = args.at(-1)!;
        return existsSync(plist)
          ? { exitCode: 0, stderr: "", stdout: await readFile(plist, "utf8") }
          : { exitCode: 1, stderr: "missing", stdout: "" };
      }
      if (executable === "/usr/bin/ditto") {
        await writeApp(join(args.at(-1)!, "Pronto.app"), "0.5.0");
        return { exitCode: 0, stderr: "", stdout: "" };
      }
      if (executable === "/usr/bin/codesign") {
        return { exitCode: options.signatureValid === false ? 1 : 0, stderr: "", stdout: "" };
      }
      if (executable === "/usr/bin/pgrep") return { exitCode: 0, stderr: "", stdout: "123\n" };
      return { exitCode: 0, stderr: "", stdout: "" };
    },
    verifyEnvelope: () => manifest(),
  });
  return { calls, installer, paths };
}

describe("menu bar installer", () => {
  test("updates an installed app atomically and reopens it", async () => {
    const h = await harness({ installedVersion: "0.4.3" });
    expect(await h.installer.check()).toEqual({ installedVersion: "0.4.3", status: "available", version: "0.5.0" });
    expect(await h.installer.install({ onlyIfInstalled: true })).toEqual({ status: "installed", version: "0.5.0" });
    expect(await h.installer.installedVersion()).toBe("0.5.0");
    expect(h.calls).toContainEqual([
      "/usr/bin/osascript", "-e", `tell application id "${MENUBAR_BUNDLE_IDENTIFIER}" to quit`,
    ]);
    expect(h.calls).toContainEqual(["/usr/bin/open", "-b", MENUBAR_BUNDLE_IDENTIFIER]);
    const codesign = h.calls.find(([executable]) => executable === "/usr/bin/codesign")!;
    expect(codesign.join(" ")).toContain(`identifier "${MENUBAR_BUNDLE_IDENTIFIER}"`);
    expect(existsSync(join(h.paths.updateDirectory, ".menubar-test"))).toBe(false);
    expect(await h.installer.install()).toEqual({ status: "current", version: "0.5.0" });
  });

  test("leaves a missing app alone during automatic updates", async () => {
    const h = await harness();
    expect(await h.installer.install({ onlyIfInstalled: true })).toEqual({ status: "not_installed" });
    expect(h.calls.some(([executable]) => executable === "/usr/bin/ditto")).toBe(false);
  });

  test("keeps the existing app when the download or signature does not verify", async () => {
    const tampered = await harness({ archiveBytes: new TextEncoder().encode("zipped Pronto.apX"), installedVersion: "0.4.3" });
    await expect(tampered.installer.install()).rejects.toThrow("menubar_artifact_digest_mismatch");
    expect(await tampered.installer.installedVersion()).toBe("0.4.3");

    const unsigned = await harness({ installedVersion: "0.4.3", signatureValid: false });
    await expect(unsigned.installer.install()).rejects.toThrow("menubar_signature_mismatch");
    expect(await unsigned.installer.installedVersion()).toBe("0.4.3");
    expect(existsSync(join(unsigned.paths.updateDirectory, ".menubar-test"))).toBe(false);
  });
});
