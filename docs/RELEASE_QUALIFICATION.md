# Release qualification

Public release requires every automated gate and an owner-run live smoke. This
file records capability evidence, not private conversation data.

The next candidate is v0.4.2-candidate.3. Candidate.1 failed restart qualification;
candidate.2 was disqualified during review before installation. Neither may publish.
It preserves checkpoint rollback compatibility with the released 0.2.0 SDK while
retaining the reboot-stable generation and witnessed, no-rewind recovery. The
0.4.1 release below is historical evidence. The release owner's explicit remote
test exception is recorded below; it is not a fresh 0.4.2 participant test.

## v0.4.2 scope

Candidate.1 source `cb0981308f03997b55ad62fc8a14a9343864b7bc` passed protected
signed CI `34857911542`, checksum verification, Developer ID requirements and
notarization. Arm64 SHA-256:
`253f6457f57fe782c7f31178516da53c07550bccf83051855fecb307a4eab147`.
Fresh self-chat reply, recent untagged context and tagged memory save each delivered
exactly once. After 32 untagged fillers, full setup restart exceeded its existing
readiness window while checkpoint catch-up was still advancing. No request replayed,
but recall was not sent and this candidate is disqualified. The original consumer
listener was restored; its two parked delivery records were unchanged.

Read-only provider profiling found 128-chat catalog reads cost 1.48–1.74 seconds
each, versus 173 ms for a 20-chat page containing the recent test chat. Stats and
single-row reads cost about 40 ms. The replacement starts with the smaller page
while retaining every larger fallback and fresh per-message routing checks. It
does not increase readiness limits, cache authority or alter checkpoints manually.

Candidate.2 source `b53acb9` and build `34860445807` were stopped before live testing:
review found that a smaller first page must apply only when the message already
carries the unique provider chat ID. Address-only resolution retains its previous
larger ambiguity search. A new regression caught duplicate address matches beyond
the first 20 chats before that restriction, then passed after it. Candidate.3 has
both the bounded recovery improvement and the preserved ambiguity check.

The checkpoint's legacy identity remains readable by older SDKs; a validated
additional field carries the reboot-stable identity for the new SDK. Old writers
may drop that field, so returning to the new SDK uses the existing fingerprint
and witness checks. Repeated upgrades retain distinct private recovery backups.
Public-interface tests exercise the real released 0.2.0 SDK across repeated
upgrade/rollback cycles, idle upgrade from released 0.4.1, and simulated remount.
No consumer state repair, cursor rewind, or new public SDK interface is required.

On 2026-09-14, the release owner said the approved remote participant was unavailable
and explicitly approved trusting the previous successful test. This is a one-release
exception to the fresh-participant step for 0.4.2 only. The carried-forward evidence
is the exact once-only participant request/reply on 0.4.1-candidate.2, verified on
2026-09-14. No new 0.4.2 remote test is claimed. Activation, runtime invocation,
outbound delivery and echo suppression are unchanged; checkpoint persistence does
change, so the ordinary unchanged-transport exception alone would not suffice.
Fresh signed 0.4.2 self-chat, context, memory, restart and no-replay checks remain
required. Signing, automated gates and consumer integration are not waived.

Rollback qualification targets the prior consumer's pre-0.4 SDK, not 0.4.1.
An exploratory downgrade to released 0.4.1 after repeated upgrades is unsupported:
that binary's fixed-name migration backup rejects a changed saved checkpoint.
The new code does not delete or replace that evidence to accommodate it. Upgrading
from 0.4.1 is covered, including an idle listener. Keep the original consumer
release as the operational rollback target, not the intermediate 0.4.1 release.

## Historical v0.4.1 qualification

The qualified candidate was v0.4.1-candidate.2. Candidate.1's live restart qualification
failed and it must not be published. Candidate.2 has passed fresh self-chat context,
memory, idle-restart and fresh remote-participant checks. The
v0.4.0 records are historical evidence, not remote qualification for this
transport-changing release.

The replacement implementation aligns setup with the updater's bounded five-minute
readiness window. Setup drains existing agents before retaining the executable,
configuration and launch files; failed qualification restores that pair before
restarting the previous listener. Delivery journals and provider checkpoints are never
rewound. Local public setup/cutover regressions cover delayed readiness, bounded failure,
deleted launch files and writes completing during drain. Candidate.2 passed the
fresh signed live restart and active-turn replacement checks.

## v0.4.1 scope

Candidate.2 source: `2d785b1d52418e8611a39eb430bd01f843317c7d`, immutable tag
`v0.4.1-candidate.2`, protected candidate-only CI run `34715754669` (2026-09-12).
Both binaries passed signing/notarization and explicit Developer ID requirements;
binary, manifest and SDK checksums passed. Arm64 SHA-256:
`ca0c776932e7f184b376b3a25c62fe6fc2fad398d396af97d7c6ac5f4313f1a3`.
Local suite: 268 passed, one opt-in fixture skipped; native drain fixture passed
separately. Full PR review against `402ee7d` found no outstanding standards or
implementation findings; fresh live qualification is recorded below.

The exact candidate was installed on Omini (macOS 26.6.2, imsg 0.15.0, Codex
0.154.0). Effective runtime qualification passed without an agent approval prompt.
Setup recovered the saved checkpoint through bounded duration-limited passes and
reached ready; the installed hash still matches. No extra Full Disk Access or
Automation grant was needed. One fresh synthetic self-chat request has delivered
exactly once, with one matching Messages outbound GUID. Fresh recent untagged context
and tagged memory save each passed. After 32 untagged filler messages and a full
signed setup restart, memory recall returned the correct name exactly once. The
filler messages invoked no agent and the four completed requests were not replayed.
Tested content was absent from daemon logs. Setup then drained a fifth synthetic
request, including its 25-second child command, and confirmed exactly one reply
before replacement; the restored listener returned to ready. All five outbound GUIDs
were witnessed exactly once in Messages, without a synthetic echo turn more than
one minute later. On 2026-09-14 the owner reported the approved remote participant
sent the fresh candidate.2 test. Read-only journal and Messages evidence confirmed
an incoming participant request (not a self-chat/outgoing mirror), the exact requested
synthetic response, and exactly one outbound GUID in that same conversation. Tested
content remained absent from logs; the installed checksum still matches candidate.2.
No automated test message was sent to that participant. Candidate.1 evidence is not
reused. Only qualification documentation may differ from candidate.2 at v0.4.1;
no runtime change is qualified by this record.

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
| macOS | 26.6.2 | Exact signed candidate installation still required | Pending |
| Bun | 1.3.14 | 275 local tests passed, one opt-in fixture skipped; frozen install, typecheck and build passed | Pass |
| Node.js | 22.23.1 | Packed import passed locally; clean signed CI validation pending | Pending |
| imsg | 0.15.0 | Exact candidate protocol and live read/watch/send pending | Pending |
| Codex CLI | 0.154.0 | Fresh setup and live turns pending | Pending |
| Claude Code | 2.1.260 | Adapter fixtures pass; unchanged runtime adapter qualification requires review | Pending |
| Codex effective local probe | 0.154.0 | Fresh exact-candidate setup probe pending | Pending |
| Claude effective local probe | 2.1.260 | Unchanged runtime adapter qualification requires review | Pending |
| Messages Automation | v0.4.2-candidate.3 | Fresh confirmed self-chat send pending | Pending |
| Self-chat mirror handling | v0.4.2-candidate.3 | Fresh reply, context, memory, restart and no-replay checks pending | Pending |
| Full remote tagged flow | v0.4.2 | Owner-approved one-release exception on 2026-09-14 carries 0.4.1-candidate.2 remote evidence; no fresh 0.4.2 remote test claimed | Pass |

## Historical v0.4.1 matrix

| Surface | Qualified version | Evidence | Status |
| --- | --- | --- | --- |
| macOS | 26.6.2 | Exact signed candidate.2 live qualification on Omini | Pass |
| Bun | 1.3.14 | Frozen install, typecheck, tests, compiled build | Pass |
| Node.js | 22.23.1 | Clean packed `pronto-imessage` import and public-interface smoke | Pass |
| imsg | 0.15.0 | Candidate.2 protocol/capability qualification and live read/watch/send | Pass |
| Codex CLI | 0.154.0 | Candidate.2 setup auth/interface qualification and live turns | Pass |
| Claude Code | 2.1.260 | Auth/help inspection and adapter fixtures | Pass |
| Codex effective local probe | 0.154.0 | Candidate.2 setup noninteractive file-tool probe | Pass |
| Claude effective local probe | 2.1.260 | Fresh noninteractive file-tool probe; all qualification checks passed | Pass |
| Messages Automation | v0.4.1-candidate.2 | Five fresh confirmed sends on Omini; setup restart and active-turn replacement passed | Pass |
| Self-chat mirror handling | v0.4.1-candidate.2 | Exact candidate self-chat, recent context and memory after 32 fillers/restart passed; no echo | Pass |
| Full remote tagged flow | v0.4.1 | Fresh candidate.2 participant request and exact once-only reply verified 2026-09-14; no automated remote messages | Pass |

Candidate.2 automated/self-chat checks ran on 2026-09-12; the fresh remote test ran
on 2026-09-14. Claude-specific probe evidence is retained from 2026-09-04: its
runtime adapter and invocation were unchanged; Omini selected Codex for all fresh
transport qualification. No prior transport or remote-participant proof is carried forward.
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
