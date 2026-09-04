import { createHash, createPrivateKey, sign } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  PRONTO_SIGNING_IDENTIFIER,
  PRONTO_SIGNING_TEAM_IDENTIFIER,
  PRONTO_UPDATE_KEY_ID,
  releaseSequenceForVersion,
  type ProntoUpdateArtifact,
  type ProntoUpdateManifest,
  type ProntoUpdateTarget,
  type SignedProntoUpdateEnvelope,
} from "../packages/cli/src/update";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value === "") throw new Error(`${name} is required`);
  return value;
}

const directory = required("PRONTO_RELEASE_DIRECTORY");
const version = required("PRONTO_RELEASE_VERSION");
const revision = required("PRONTO_RELEASE_REVISION");
const publishedAt = new Date(required("PRONTO_RELEASE_PUBLISHED_AT"));
const privateKeyPem = required("PRONTO_RELEASE_ED25519_PRIVATE_KEY");
if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error("release revision must be a full commit SHA");
if (!Number.isFinite(publishedAt.getTime())) throw new Error("release publication time is invalid");
const expiresAt = new Date(publishedAt.getTime() + 366 * 24 * 60 * 60 * 1_000);

async function artifact(target: ProntoUpdateTarget): Promise<ProntoUpdateArtifact> {
  const name = `pronto-${target}`;
  const path = join(directory, name);
  const [bytes, details] = await Promise.all([readFile(path), stat(path)]);
  if (!details.isFile() || details.size <= 0) throw new Error(`release artifact is invalid: ${name}`);
  return {
    url: `https://github.com/eabnelson/pronto/releases/download/v${version}/${name}`,
    size: details.size,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    macosSigning: {
      identifier: PRONTO_SIGNING_IDENTIFIER,
      teamIdentifier: PRONTO_SIGNING_TEAM_IDENTIFIER,
    },
  };
}

const payload: ProntoUpdateManifest = {
  schemaVersion: 1,
  product: "pronto",
  version,
  releaseSequence: releaseSequenceForVersion(version),
  channel: "stable",
  publishedAt: publishedAt.toISOString(),
  expiresAt: expiresAt.toISOString(),
  sourceRevision: revision,
  minimumUpdaterVersion: "0.3.0",
  artifacts: {
    "darwin-arm64": await artifact("darwin-arm64"),
    "darwin-x64": await artifact("darwin-x64"),
  },
};
const payloadBytes = Buffer.from(JSON.stringify(payload));
const signature = sign(null, payloadBytes, createPrivateKey(privateKeyPem));
const envelope: SignedProntoUpdateEnvelope = {
  keyId: PRONTO_UPDATE_KEY_ID,
  payload: payloadBytes.toString("base64url"),
  signature: signature.toString("base64url"),
};
await writeFile(join(directory, "pronto-update.json"), `${JSON.stringify(envelope)}\n`, {
  encoding: "utf8",
  mode: 0o600,
});
