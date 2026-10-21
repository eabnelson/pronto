# Slack beta release checks

Slack is an opt-in beta: the owner adds a workspace explicitly, and recovery uses
bounded searches for recent tags. It does not ingest workspace histories and does
not promise exhaustive offline recovery.

## Required for release

Use the normal automated suite and signed build, plus four recorded results:

1. **Signed arm64 helper:** verify the downloaded CLI checksum, embedded helper
   self-test and signature. Record the artifact hash.
2. **Signed x64 helper:** repeat verification for the x64 artifact. Rosetta
   execution is acceptable for this beta; label it accurately instead of claiming
   native Intel testing.
3. **Owner acceptance:** record the owner's experience with the installed
   candidate. Ordinary daily use counts; a separate benchmark is unnecessary.
4. **Setup and reply:** add a workspace, assign a tag through the central Tags UI,
   and confirm one tagged request gets one correctly routed reply. Confirm the
   installed listener is healthy and starts unattended. Existing observed evidence
   can cover unchanged behavior; name the candidate and reviewed unchanged source.

The short common release checklist in [LIVE_SMOKE.md](LIVE_SMOKE.md) covers startup
and rollback readiness; reuse its evidence rather than repeating the same test.

Initialize private evidence inside this checkout with:

```sh
bun scripts/slack-qualification.ts --init .scratch/slack-channel/qualification.json <release-tag>
```

Copy only redacted results and exact artifact hashes into
[slack-qualification.json](slack-qualification.json), then run:

```sh
bun scripts/slack-qualification.ts --check docs/slack-qualification.json <release-tag>
```

Pending or failed required checks still block publishing. Candidate-only signing
does not publish. Approval to test or sign is separate from approval to publish.
Never record private conversation content, identities or credentials in Git.

## Follow-up testing

Two-hour sleep exercises, fixed-duration/five-conversation performance campaigns,
multi-workspace live matrices, native Intel runs, and the exhaustive Slack
open/closed/updated and credential-denial/revocation matrix are follow-up work,
not beta release gates. Unperformed cases remain unperformed; do not mark them
passed or advertise guarantees based on them. Reported failures in supported use
still need triage and fixes before shipping.

Keep automated regressions for scope/identity isolation, credential containment,
bounded recovery, revocation, duplicate suppression and ambiguous sends. Rerun
targeted live checks when a change touches those behaviors or a real bug needs
reproduction. Policy simplified on 2026-10-21 at the owner's request to reduce
testing overhead and accept owner daily use as practical evidence.
