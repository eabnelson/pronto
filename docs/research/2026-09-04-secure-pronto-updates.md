# Secure signing, notarization, and updates for Pronto

- **Research date:** 2026-09-04
- **Pronto inspected:** `c489bcf` (`0.2.4` work in progress; released baseline `0.2.3`)
- **Studio Four inspected:** `238646e` (exactly pins `pronto-imessage@0.2.3`)
- **Source policy:** Apple, GitHub, and npm primary documentation plus local Pronto and Studio Four source

## Decision

Pronto should have two independent trust layers:

1. Sign every official macOS executable with one stable **Developer ID Application** identity, the permanent identifier `dev.pronto.cli`, Hardened Runtime, and a secure timestamp; then notarize the exact distributed bytes.
2. Authenticate update metadata with a dedicated, rotatable Ed25519 release key embedded in Pronto. A signed manifest must bind a monotonic release sequence to the artifact URL, byte length, SHA-256, source revision, required updater version, and expected macOS Team ID plus signing identifier.

Developer ID establishes Apple-recognized code identity and is what lets macOS recognize an updated executable as the same program. It does not prevent a compromised download host from serving an older valid release. The signed update manifest provides origin, freshness, and rollback resistance; HTTPS and unsigned checksum sidecars do not.

Do not make Studio Four dynamically install or update the standalone Pronto binary. `pronto-imessage` is an in-process library whose consumers explicitly own installation, updates, signing, LaunchAgent identity, and permissions ([ADR 0003](../adr/0003-scope-messages-access-to-observed-conversations.md#consequences)). Studio Four should continue to exact-pin the npm package, compile it into its own Developer ID-signed host, and ship that host through Studio Four's existing signed-maintenance path.

## Priority

| Priority | Recommendation |
| --- | --- |
| **Must, before an official unattended update** | Replace Pronto's ad-hoc release signature with stable Developer ID signing, Hardened Runtime, timestamping, notarization, and exact identifier/Team verification. |
| **Must** | Put Apple credentials in a protected GitHub `release` environment; expose them only to a manually approved release job from an immutable tag. Never expose them to PR, `pull_request_target`, third-party code, or a persistent self-hosted runner. |
| **Must** | Publish and verify a signed, bounded update manifest. Persist the highest installed release sequence and reject replay/downgrade. Keep one last-known-good binary and replace atomically only after full verification. |
| **Must** | Treat the Developer ID PKCS#12, notarization API `.p8`, and update-manifest signing key as three different credentials with separate rotation and revocation procedures. |
| **Should** | Ship a signed and stapled flat `.pkg` (or signed/stapled `.dmg`) as the human-facing installer. Keep a notarized ZIP/binary for the updater, while accepting that Apple cannot staple a ticket directly to a ZIP or standalone binary. |
| **Should** | Add GitHub artifact attestations for the Pronto binary and continue npm trusted publishing/provenance for `pronto-imessage`; these add auditable build provenance but do not replace runtime manifest verification. |
| **Defer** | Background auto-update until manual `pronto update` has field evidence for permission continuity, drain/restart, health qualification, and rollback on each supported macOS version. |

## Stable signing and Full Disk Access

Apple documents a designated requirement (DR) as the rule macOS uses to decide whether new code is the same code it saw before. It specifically describes privacy authorization surviving an update when the new version satisfies the original DR; unsigned code has no DR, while an ad-hoc DR is tied to one build ([TN3127](https://developer.apple.com/documentation/technotes/tn3127-inside-code-signing-requirements), [Applying Code Requirements](https://developer.apple.com/documentation/security/applying-code-requirements)). A default Developer ID DR includes an Apple-issued anchor, the developer Team ID, and the signing identifier. Consequently:

- Keep `dev.pronto.cli` and the chosen Apple Developer Team ID immutable across releases and certificate renewal.
- Inspect every release with `codesign --display --requirements - --verbose=4`, and verify it against `anchor apple generic and identifier "dev.pronto.cli" and certificate leaf[subject.OU] = "<TEAM_ID>"`.
- Sign the actual responsible executable installed at `~/Library/Application Support/pronto/bin/pronto`; keep that stable path and LaunchAgent relationship.
- Expect one permission re-grant when moving existing ad-hoc installations to the first Developer ID-signed build. Thereafter, a binary that satisfies the same original DR should retain privacy authorization.
- Changing signer team, identifier, distribution mode, or responsible process is an identity migration and may require a new grant.

This is strong evidence for TCC continuity, but Apple does not explicitly guarantee every manual Full Disk Access transition for every launcher/path combination. Treat FDA persistence as a release qualification test, not a theorem: install the prior production build, grant FDA, upgrade using the candidate path, restart the LaunchAgent, and prove a bounded `chat.db` read without touching the System Settings grant. Test the actual launcher attribution chain on each supported macOS release. Apple's managed-device PPPC documentation likewise binds System Policy All Files access to a code-signing requirement ([PPPC payload](https://support.apple.com/guide/deployment/privacy-preferences-policy-control-payload-dep38df53c2a/web)).

Pronto already preserves the installation path and atomically renames a staged executable into place (`packages/cli/src/macos/setup.ts:652-700`), but official CI currently produces only an ad-hoc signature: `signProntoExecutable` defaults to `-` and supplies neither Hardened Runtime nor timestamp (`packages/cli/src/macos/setup.ts:577-605`; `scripts/build.ts:18-35`). The release workflow verifies that this ad-hoc signature is internally valid but does not check Team ID, notarize, or assess Gatekeeper (`.github/workflows/release.yml:43-50`). That is insufficient for stable TCC identity or external distribution.

Apple's current notarization requirements are a Developer ID certificate, valid signatures on all executables, Hardened Runtime for command-line targets, a secure timestamp, no true `get-task-allow`, and an appropriate SDK ([Notarizing macOS software](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution), [Creating distribution-signed code](https://developer.apple.com/documentation/xcode/creating-distribution-signed-code-for-the-mac)). For Pronto's single Mach-O, sign with `codesign --force --options runtime --timestamp --identifier dev.pronto.cli --sign <identity>`. Use `--deep` only for verification, not signing nested code.

## Credentials in a public GitHub repository

GitHub encrypts Actions secrets before upload, injects them only when a workflow explicitly references them, and can delay environment secrets until required approval ([Secrets](https://docs.github.com/en/actions/concepts/security/secrets), [Deployments and environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments)). Masking is not a security boundary: code executing in a privileged job can read and exfiltrate its environment ([Compromised runners](https://docs.github.com/en/actions/concepts/security/compromised-runners)). The safe boundary is therefore the workflow and revision allowed to receive the secret.

Use a `release` environment with required reviewers and tag-only deployment rules. The signing/notarization job should run on an ephemeral GitHub-hosted macOS runner, checkout the already reviewed immutable tag by full commit SHA, use least-privilege `GITHUB_TOKEN` permissions, pin every action to a full commit SHA, and never run on PR events. Avoid `pull_request_target` and persistent self-hosted runners for this public repository; GitHub explicitly warns that untrusted workflow code can compromise them ([Secure use reference](https://docs.github.com/en/actions/reference/security/secure-use)).

Store these separately:

- `PRONTO_DEVELOPER_ID_P12_B64` and its strong import password: code-signing certificate plus private key.
- `PRONTO_NOTARY_KEY_P8_B64`, key ID, and issuer ID: notarization authentication only.
- `PRONTO_RELEASE_ED25519_PRIVATE_KEY`: signs exact manifest payload bytes, never binaries.

Base64 is transport encoding, not protection. Materialize credentials under `$RUNNER_TEMP`, import the PKCS#12 into a fresh randomly-passworded temporary keychain, restrict the keychain search list, and delete both keychain and files in an `always()` cleanup step. Do not print identities beyond the public certificate subject/Team ID, enable shell tracing, pass secrets as command arguments when avoidable, cache the keychain, upload it as an artifact, or let release-time scripts execute arbitrary unreviewed inputs. Rotate immediately on suspected exposure.

Studio Four's current release workflow is a useful implementation template: it creates a temporary keychain, imports the PKCS#12, signs with `--options runtime --timestamp`, checks exact identifier and Team ID, notarizes, and removes temporary material (`/Users/erik/Studio/studiofour/studiofour/.github/workflows/cli-release.yml:70-144,194-210`). For a public Pronto repo, add the protected environment/manual gate and use GitHub-hosted rather than Studio Four's persistent self-hosted runner.

### Notarization authentication

Use a **team** App Store Connect API key with `notarytool`, not an individual key and not `altool`. Apple states that individual API keys cannot use `notarytool`; team keys are role-scoped but cover all apps and are downloadable only once ([Creating API Keys](https://developer.apple.com/documentation/appstoreconnectapi/creating-api-keys-for-app-store-connect-api)). Submit with `xcrun notarytool submit <archive> --issuer <issuer> --key-id <id> --key <p8-path> --wait`, require `Accepted`, and inspect the notarization log even on success ([TN3147](https://developer.apple.com/documentation/technotes/tn3147-migrating-to-the-latest-notarization-tool), [Customizing notarization](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow)).

The API key is appropriate because it is revocable and removes a human Apple ID/app-specific password from CI. It cannot sign code and must not be confused with the Developer ID key. Choose the least role that successfully notarizes for the team and test it; Apple lists notarization as a role-controlled developer-program permission ([roles](https://developer.apple.com/help/account/access/roles)).

A ZIP is accepted for notarization, but Apple cannot staple a ticket to a ZIP or standalone binary. Gatekeeper can retrieve its online ticket. A signed flat installer package or disk image can carry a stapled ticket and is preferable for offline first launch ([Customizing notarization](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow)).

## Update manifest and installer contract

The current Pronto release publishes SHA-256 sidecars and rechecks them between CI jobs (`.github/workflows/release.yml:69-86,128-141`). That detects corruption inside the workflow, but a checksum beside a binary on the same mutable hosting authority is not an authenticity or anti-rollback mechanism.

Publish an immutable, versioned manifest envelope no larger than 64 KiB:

```json
{
  "keyId": "pronto-release-v1",
  "payload": "<base64url exact JSON bytes>",
  "signature": "<Ed25519 signature over payload bytes>"
}
```

The payload should contain `schemaVersion`, `product`, semantic `version`, strictly increasing `releaseSequence`, `channel`, `publishedAt`, `expiresAt`, `sourceRevision`, `minimumUpdaterVersion`, and one artifact per architecture with an allowlisted HTTPS URL, exact byte `size`, `sha256`, `macosSigning.identifier`, and `macosSigning.teamIdentifier`. Include release-key rotation metadata and a security/capability-expansion marker. Sign bytes rather than reparsed JSON.

Embed trusted public keys and their status in Pronto. Verify envelope size, key ID/status, Ed25519 signature, schema, time bounds, stable channel, updater compatibility, sequence monotonicity, exact URL origin/path, and target before downloading. Download into a private directory with a size cap and timeout; verify length and SHA-256; verify strict codesign validity plus the exact DR; then run a bounded version/self-test. Stop and drain the daemon, stage with mode `0700`, atomically rename, update the configured installed hash, restart, and qualify database/watch health before promotion. Preserve the old binary and prior state until qualification; rollback on startup failure. Never interpret rollback as permission to replay an ambiguous outbound message.

Persist the highest accepted `releaseSequence` separately from the replaceable binary so a valid old manifest cannot downgrade it. Allow an explicit, authenticated emergency rollback sequence to point to older artifact bytes; do not lower the sequence. Key rotation should ship the next public key in an earlier trusted release with an overlap window and explicit revocation state.

Studio Four already implements most of this pattern: Ed25519 envelopes, bounded fetches, expiry and release-sequence checks, capability coverage, digest and stable code-identity verification, idle-boundary install, candidate qualification, last-known-good rollback, and bounded retention (`/Users/erik/Studio/studiofour/studiofour/packages/channel-host/src/maintenance.ts:17-161,237-388`; `packages/channel-host/src/macos/launcher.ts:123-235,319-330`). Reuse the design and tests, not a shared runtime updater abstraction.

GitHub artifact attestations can additionally bind a binary to repository, workflow, commit, and triggering event; use `id-token: write`, `attestations: write`, and a SHA-pinned `actions/attest` on the built assets ([GitHub artifact attestations](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations)). They are valuable audit evidence, but Pronto's updater should remain self-contained around its embedded manifest public key.

## Phased delivery

### Phase 0 — release identity (blocker)

Choose and record Pronto's Team ID; keep `dev.pronto.cli`; move release signing to a protected GitHub-hosted macOS job; add Hardened Runtime, timestamp, strict DR/Team checks, notarization, log inspection, and a clean-Mac Gatekeeper smoke. Publish signed/stapled `.pkg` plus the updater's notarized archive. Qualify the one-time ad-hoc-to-Developer-ID permission migration and a subsequent signed-to-signed upgrade.

### Phase 1 — verified manual update

Add `pronto update --check` and explicit `pronto update` only. Introduce the signed manifest, immutable version paths, monotonic sequence state, bounded download, exact DR/digest validation, atomic replacement, last-known-good rollback, and privacy-safe diagnostics. A failed or offline check must leave the installed executable unchanged.

### Phase 2 — supervised automatic update

Only after field evidence, check at a drained turn boundary; never interrupt an accepted send. Stage and restart under the stable launcher, require heartbeat plus database/watch qualification, promote only after success, and roll back otherwise. Defer on active work, treat signature/replay/identity failures as action-required, apply bounded rollout, and retain current plus one known-good release.

### Phase 3 — Studio Four consumption

Keep `packages/channel-host/package.json` on an exact `pronto-imessage` version and commit its `bun.lock` SHA-512 resolution (`/Users/erik/Studio/studiofour/studiofour/packages/channel-host/package.json:27`; `/Users/erik/Studio/studiofour/studiofour/bun.lock:1570`). For each bump, verify npm provenance/signatures, run provider conformance and the live iMessage matrix, then release a newly signed/notarized Studio Four host through Studio Four's own manifest. Do not let standalone Pronto update Studio Four's embedded copy or share its identifier/path.

Pronto already publishes `pronto-imessage` through npm OIDC with no npm token and requests provenance (`.github/workflows/release.yml:88-99,118-127,156-164`). Keep that. npm trusted publishing requires Node 22.14+ and npm 11.5.1+, eliminates the long-lived npm token, and automatically creates provenance for public packages from public repositories ([Trusted publishing](https://docs.npmjs.com/trusted-publishers/), [provenance](https://docs.npmjs.com/generating-provenance-statements/)). Consumers can audit registry signatures and attestations with `npm audit signatures`. Provenance proves where the package was built; Studio Four's exact pin, lock integrity, review, and conformance tests still decide whether that build is acceptable.

## Release acceptance evidence

Before enabling automatic updates, require all of the following from the exact published artifact:

- Developer ID Application authority, expected Team ID and `dev.pronto.cli`, Hardened Runtime flag, secure timestamp, strict signature verification, accepted notarization, clean log, and Gatekeeper assessment.
- Previous signed production build retains FDA and Messages Automation through the update on each supported macOS release; the first ad-hoc-to-signed migration is documented separately.
- Tampered manifest, unknown/revoked key, expired manifest, wrong origin/path/target, altered size/hash, wrong Team/identifier, replayed sequence, and downgrade all fail closed without touching the installed binary.
- Power loss/interruption before and during rename recovers to current or last-known-good; candidate startup or qualification failure rolls back.
- An active turn defers update; an accepted send drains before restart; rollback never resends an uncertain effect.
- The published `pronto-imessage` tarball has npm provenance/signatures, matches the exact reviewed version and lock integrity, and passes Studio Four conformance/live qualification before Studio Four release.
