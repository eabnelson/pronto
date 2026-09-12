# Release qualification

Public release requires every automated gate and an owner-run live smoke. This
file records capability evidence, not private conversation data.

The current candidate is v0.4.1. Candidate.1's signed build passed, but live restart
qualification failed; it must not be published. A corrected immutable candidate and
fresh live qualification are required. The v0.4.0 records below are historical evidence,
not qualification for this transport-changing release.

The replacement implementation aligns setup with the updater's bounded five-minute
readiness window. Setup drains existing agents before retaining the executable,
configuration and launch files; failed qualification restores that pair before
restarting the previous listener. Delivery journals and provider checkpoints are never
rewound. Local public setup/cutover regressions cover delayed readiness, bounded failure,
deleted launch files and writes completing during drain. A new signed candidate and
fresh live restart qualification remain required.

## v0.4.1 scope

Candidate.1 source: `460b38975556f312c624e09eb2e9aed3b52e0b03`, immutable tag
`v0.4.1-candidate.1`, protected candidate-only CI run `34713722441` (2026-09-12).
Both signed binaries, candidate manifest and SDK package passed SHA-256 checks;
both binaries passed the explicit `dev.pronto.cli` Developer ID requirement for
team `9YCNUWK84C`. CI signing, notarization and signed artifact smoke passed.
Arm64 SHA-256: `9614df3dc11e682243a5f6f52b77961b9f529399f2861399ddd1ca200c322dfe`.
Full local suite: 266 passed, one opt-in native fixture skipped; that launchd drain
fixture passed separately. PR CI and CodeQL passed. No public release or npm
publication occurred. No fresh live row below is qualified by these automated checks.

Candidate.1 live checks on 2026-09-12 used macOS 26.6.2, imsg 0.15.0 and Codex
0.154.0. After owner-granted Full Disk Access and the Messages Automation approval,
the installed background listener was ready. Fresh self-chat reply, untagged recent
context and tagged memory save each produced one confirmed outbound GUID, witnessed
once in Messages. More than one minute later there was no echo turn. All 32 untagged
synthetic filler messages produced no agent reply. Tested content was absent from logs.

Restart through setup then failed: the restored daemon was still `starting` when
setup's approximately ten-second readiness budget expired. Provider recovery logs
reported duration-limited progress (7 then 6 rows). Setup subsequently failed to
restore its previous listener with launchctl bootstrap error 5. The exact signed
candidate is therefore disqualified; memory recall after restart was not sent.
Regression work must cover both the readiness budget and rollback's retained launch
configuration. No participant-originated test has been run; the owner was told to hold
that test. The pre-test consumer listener was restored and its two existing ambiguous
delivery fences were unchanged. No messages, credentials or checkpoints were reset.

History and intake share witnessed self-chat mirror classification. Database
generation v2 excludes transient mount numbers and normalizes creation-time
precision. An older checkpoint is upgraded only when its exact digest can be
reproduced with the current non-mount fields (bounded to nearby mount numbers)
and saved message witnesses match. Upgrade writes a private backup and preserves
the cursor and witnesses. Missing, changed or unprovable evidence remains blocked.
Local remount, compatible-upgrade, changed/missing-witness and replacement tests
pass; this does not substitute for the owner-run signed candidate checks.

The v0.4.0 candidate.1 passed
fresh self/remote replies, self-chat recent context, tagged memory beyond 32
untagged messages and an idle restart on 2026-09-04. Active-turn replacement
failed: launchd interrupted the synthetic turn before drain. The installer
refused replacement and restored the listener; the uncertain synthetic turn
remains parked without replay. Candidate.1 must not be promoted. A new candidate
with bounded shutdown qualification was required.
Never carry v0.3.0 remote evidence across v0.4.0's message-transport changes.

Candidate.1 source: `e694dcb15b2342b3b88b344912eb98abb59dcba1`, protected CI run
`33931479985`; arm64 SHA-256
`1d1590881a567bbd4f0b2b5711da011deaba7fb9c38f4de1ae4c85543b37814a`.
Both architectures passed checksum and Developer ID designated-requirement
verification. CI required notarization submit and log status Accepted. The
installed launchd candidate retained Full Disk Access and passed doctor, with
Codex 0.153.0 and imsg 0.14.1 (both CLI version and qualified protocol response).
The historical matrix's imsg 0.15.0 is not this candidate's live provider version.
No automated follow-up messages were sent to the remote chat; the owner directed
context, memory and updater tests to self-chat only.

Candidate.2 source: `a4991b1a21af2eae4961fcb6fde0896401ca4bb6`, protected CI run
`33934137599`; arm64 SHA-256
`fe78274ffe9786ed910764849d1677ca7125553ec7b77d51d2107e599ea8f0d2`.
Checksums, both Developer ID requirements, notarization, packed Node/Bun imports
and installed doctor passed. Active-turn signed replacement completed with one
confirmed synthetic reply and returned to ready; the previous uncertain event
remained parked without replay. Fresh self-chat recent context and tagged memory
save also passed, with one confirmed send each. No automated remote messages
were sent.

After 32 new untagged self-chat messages and an idle restart, the new recall
request was visible in Messages but absent from the journal. The log reported
duration-limit while status falsely reported ready. Candidate.2 is therefore
also disqualified. Local regressions cover readiness before subscription,
persisted recovery degradation, and checkpoint retry after a catch-up deadline.
Those runtime changes require another immutable signed candidate and fresh
qualification; candidate.2 evidence alone did not permit publication.

Candidate.3 source: `bf21c82556fcb06afb967ec09023d47a50aa92c5`, protected CI run
`33936524743`. Artifact checksums, both Developer ID requirements and CI
notarization passed. Its truthful degraded status exposed a separate qualification
budget mismatch: checkpoint recovery made progress, but the 30-second installer
readiness window expired. The qualification installer restored candidate 2 and
its exact integrity hash; the parked synthetic event remained unchanged. No
additional live message was sent on candidate 3. The updater now allows five
minutes of scheduled readiness checks while still requiring ready and preserving
rollback. This runtime change requires another immutable signed candidate.

Candidate.4 source: `549b61db591b6531e4dbb6e4b7a976ad6740d076`, protected CI run
`33937150637`; installed arm64 SHA-256
`592ef83947cc6fe3672240f814e2e28e1e6b08a766193a6d1dc86f69e7a5e0a1`.
Checksums, both Developer ID requirements, CI notarization, packed Node/Bun
imports, installed doctor and fresh effective Codex/Claude probes passed.
Automated verification passed 262 tests, with one opt-in native test skipped;
the native 25-second active-child drain fixture passed separately.

On 2026-09-04, this exact signed candidate recovered the previously unadmitted
synthetic recall from its durable checkpoint and confirmed one reply, without a
manual rewind. That recall followed 32 untagged self-chat messages and an idle
restart, testing tagged memory outside the recent window. A separately sent
repeat recall also received one reply; the two distinct requests are not one
duplicated event. Fresh self-chat recent-context qualification passed. An idle
signed-to-signed replacement preserved the settlement watermark; replacement
during a fresh active synthetic request drained one confirmed reply and returned
to ready. The original uncertain candidate.1 event remains parked unchanged,
without replay. More than one minute later, no synthetic echo turn appeared.

The owner confirmed a fresh participant-originated remote response on candidate.4;
the delivery journal independently confirmed one delivered event and one outbound
GUID, with the exact requested synthetic reply. The participant used a shorter
synthetic marker than suggested; it was a fresh request on this candidate, not
carried-forward evidence. All automated context, memory, filler and replacement
tests stayed in self-chat. No automated message was sent to the remote chat.
The listener is ready, with zero active/ambiguous events and the one preserved
parked event. Qualification-period log checks found no tested message content.
Only this qualification record and its review may differ from candidate.4 at
the final v0.4.0 tag; no runtime change is qualified by this evidence.

## Current matrix

| Surface | Qualified version | Evidence | Status |
| --- | --- | --- | --- |
| macOS | 26.5.1 (25F80) | Local build and synthetic suite | Pass |
| Bun | 1.3.14 | Frozen install, typecheck, tests, compiled build | Pass |
| Node.js | 22.23.1 | Clean packed `pronto-imessage` import and public-interface smoke | Pass |
| imsg | 0.14.1 | Fresh CLI version, protocol/capability qualification and live read/watch/send on candidate.4 | Pass |
| Codex CLI | 0.153.0 | Auth/help inspection and adapter fixtures | Pass |
| Claude Code | 2.1.260 | Auth/help inspection and adapter fixtures | Pass |
| Codex effective local probe | 0.153.0 | Setup noninteractive file-tool probe | Pass |
| Claude effective local probe | 2.1.260 | Fresh noninteractive file-tool probe; all qualification checks passed | Pass |
| Messages Automation | v0.4.1 | Candidate.1 initial send passed but restart failed; corrected candidate required | Blocked |
| Self-chat mirror handling | v0.4.1 | Exact signed candidate smoke required | Pending |
| Full remote tagged flow | v0.4.1 | Fresh owner-run participant test required; no automated remote messages | Pending |

The automated matrix and owner smoke record versions tested on 2026-09-04.
Capability checks, not version
strings alone, determine whether setup and startup proceed.

## Automated release gates

- `bun install --frozen-lockfile`
- `bun run typecheck`
- `bun test`
- `bun run build`
- `bun run release:validate`
- Packed `pronto-imessage` imports successfully under Node.js 22.23.1 and Bun 1.3.14
- Compiled `pronto` version/help and strict macOS signature smoke checks
- Clean-room provenance and third-party notices present
- `pronto-imessage` is packed, checksummed, attached to the immutable GitHub
  release, and published to npm with provenance only after this matrix passes
- No dependency or import from Studio Four packages
- No model override or inherited interactive permission mode in adapters
- Exact unrestricted no-prompt flag present in each runtime adapter and required
  by setup qualification
- Synthetic duplicate, fallback, recovery, queue, privacy, and ambiguous-send
  cases pass against an on-disk SQLite database
- Static ownership checks reject any standalone provider RPC client, parser, probe,
  raw watch/catch-up methods, or direct provider-history implementation outside
  `pronto-imessage`

## Owner-only gate

Run `docs/LIVE_SMOKE.md` after installing the exact release candidate. Normally,
mark the remote row Pass only after a remote participant's exactly-one reply,
recent context, tagged continuity, restart suppression, and content-free logs are
observed. When the checklist's narrowly scoped carry-forward exception applies,
record the prior remote release, fresh exact-candidate self-chat evidence, and the
reviewed unchanged surfaces in the matrix. Do not publish a GitHub release while
any cell is Pending or Blocked.
