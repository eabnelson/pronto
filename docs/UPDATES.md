# Signed releases and automatic updates

Pronto has two independent release surfaces:

- The standalone `pronto` executable owns its installed path, LaunchAgents,
  macOS privacy identity, signed update manifest, qualification, and rollback.
- The public `pronto-imessage` package is an in-process library. Consumers such
  as Studio Four exact-pin it and ship it inside their own signed host. Pronto
  never mutates a consumer's embedded copy.

## User lifecycle

Setup installs the listener at
`~/Library/Application Support/pronto/bin/pronto` and a periodic
`dev.pronto.updater` LaunchAgent. The updater runs every six hours, stays quiet
when the installed version is current or the network is unavailable, and only
installs a newer stable release after every authenticity check passes.

Existing source-built releases are ad-hoc signed. Automatic update refuses to
replace one because doing so would invalidate its Full Disk Access identity.
The old binary cannot update itself because the update command begins in 0.3.0.
Download and verify the official signed candidate using the Quick start steps,
then run the migration from that separate candidate path:

```sh
"$PRONTO_CANDIDATE" update --migrate-signing
```

After the signed binary is installed, remove the stale Pronto row from System
Settings → Privacy & Security → Full Disk Access, add the exact installed path,
and run `pronto doctor` and `pronto status`. Future signed-to-signed updates keep
the same path, identifier, and Team ID and do not rerun setup.

Manual controls remain available:

```sh
pronto update --check
pronto update
```

## Verification and promotion

The latest pointer is
`https://github.com/eabnelson/pronto/releases/latest/download/pronto-update.json`.
It is safe to be mutable because its envelope is signed by a release key whose
public half is embedded in Pronto. The signed payload binds:

- schema, product, stable channel, semantic version, and release sequence;
- publication and expiry times, source revision, and minimum updater version;
- one immutable GitHub release URL per macOS architecture;
- exact byte size, SHA-256, signing identifier, and Apple Team ID.

The updater verifies the envelope before parsing its payload, rejects replay and
downgrade, downloads with time and size bounds into an owner-private directory,
verifies the artifact and Apple designated requirement, and executes the
candidate's version command. It then gracefully unloads the listener, atomically
replaces the executable, refreshes the stored integrity hash, restarts launchd,
and waits for content-free health. Failure restores the last-known-good binary
and configuration. The old updater process remains alive during this transaction,
so it can roll back even when the candidate cannot start.

## Release credentials

The public repository contains only the public manifest key, Team ID, signing
identifier, workflow logic, and secret names. Configure these in the protected
GitHub `release` environment:

- `PRONTO_DEVELOPER_ID_P12_B64`
- `PRONTO_DEVELOPER_ID_P12_PASSWORD`
- `PRONTO_NOTARY_KEY_P8_B64`
- `PRONTO_NOTARY_KEY_ID`
- `PRONTO_NOTARY_ISSUER_ID`
- `PRONTO_RELEASE_ED25519_PRIVATE_KEY`

The environment permits only `v*` tags and requires release-owner approval. The
workflow checks out that immutable tag, runs all tests and live-evidence gates,
imports the certificate into a temporary keychain on a GitHub-hosted macOS
runner, signs with Hardened Runtime and timestamping, verifies the exact
designated requirement, submits both architectures to `notarytool`, and deletes
all temporary signing material in an `always()` step.

The publish job receives no Apple or manifest private key. It verifies checksums,
creates GitHub artifact attestations, publishes `pronto-imessage` through npm
OIDC with provenance, verifies registry propagation, and only then makes the
immutable GitHub release public.

## Release qualification

When the signing identity is available only in CI, first freeze the runtime and
package version on an immutable `v<version>-candidate.<number>` tag. Dispatch
`release.yml` on that tag with `candidate_only=true`. Candidate tags do not
trigger automatic release builds; the manual build still requires the protected
`release` environment and runs the same tests, signature and notarization checks.
It uploads a `pronto-candidate` Actions artifact with checksums and source/run
metadata, but creates no update manifest, npm publication or GitHub release.

Download the artifact from that exact successful run, verify both checksum files
and the Developer ID designated requirement before executing it. Keep a private
copy of the installed binary/configuration and use the existing quiesce and
identity-preserving installation lifecycle. Never install an ad-hoc substitute to
complete the live gate. Record the candidate source revision, binary checksum,
version and fresh owner smoke in the qualification evidence. Freeze runtime code
through qualification; a runtime change requires a new candidate and fresh smoke.
Only qualification/documentation changes may separate the candidate source from
the final same-version release tag, and that diff must be reviewed explicitly.

Before tagging a release, install the exact signed candidate over the prior
signed production release on every supported macOS version. Confirm that Full
Disk Access remains effective from the launchd-started listener, one explicit
tag produces exactly one reply, an active turn drains before replacement, and a
synthetically broken candidate rolls back. Record only content-free evidence in
`docs/RELEASE_QUALIFICATION.md`.
