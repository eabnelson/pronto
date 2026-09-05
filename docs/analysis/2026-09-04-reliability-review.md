# Reliability candidate review

Baseline: `700155e6ce03ad6d51dc498724f4bb6608e209f0`. The remote main update to `04f92a9` was a merge-only commit with no tree difference. Reviewed work: arrival/buffer recovery, reconnect deadlines/backoff, positioned scoped history and candidate-only signing. Standards and Spec reviewed sequentially under the workspace's subagent mapping.

## Standards

The public module remains independent of downstream product code; raw RPC stays internal. The optional position does not create an unscoped capability or replace generation, expiry, routing or cumulative-budget checks. Arrival handling keeps a fixed 256-entry notification buffer and one drain task. Request close-wait listeners are removed after completion; closed subscriptions discard pending memory. These review cleanups resolved resource-lifetime concerns without introducing another queue framework.

Candidate signing reuses the existing protected build job rather than duplicating signing logic. Candidate tags are excluded from automatic release triggers. Manual candidate input fences the entire publish job and update-manifest generation; ordinary releases retain the owner qualification gate and immutable version/tag checks. No credential, Apple identity or npm trust policy was changed. YAML and shell syntax were checked; removal-of-guard regressions pass. No blocking Standards findings remain for the candidate.

## Spec

Regressions cover delayed live callbacks, bounded 10,000-notification recovery, historical age limits, stable versus flapping backoff, reconnect deadline exhaustion without late send submission, synchronous connection-factory failure, and scoped history positions. Existing standalone duplicate, uncertain-effect, shutdown, updater, signature, rollback and Node/Bun compatibility suites remain green. The replay prototype is preserved at `3faa60c` and the proposed ADR records its limitations.

The exact candidate has not completed owner live smoke or signed-to-signed replacement. Historical v0.3.0 evidence cannot qualify changed v0.4.0 transport. Candidate artifacts are for qualification only; the public release gate deliberately still fails for v0.4.0. No real message was sent during local verification. Downstream durable-worker crash-boundary qualification and exact published-version adoption remain separate work, not established by these provider tests.

Summary: Standards 0 unresolved blocking findings; Spec 1 release-blocking qualification gap (fresh signed-candidate owner smoke). Local typecheck/build, 256 tests and offline release validation passed before candidate publication; the protected CI run must independently repeat them.

## Active-drain follow-up review

The live candidate-1 updater check exposed a release-blocking shutdown defect,
not a failed Messages transport or authorization check. A real launchd fixture
reproduced the interrupted child with the generated plist. The selected fix
declares a finite 120-second exit window and a matching 125-second unload wait,
quiesces the coordinator synchronously on shutdown, and leaves unstarted work
durable. The native fixture now drains a 25-second child successfully; the
SQLite lifecycle regression drains one active turn, rejects a racing arrival,
and retains the next queued receipt. A shutdown already requested during startup
also quiesces before recovering/scheduling the queue.

Standards: no new IPC, persistent disable flag, task framework, stored message
format, provider ownership change or automatic replay is introduced. Existing
unknown-effect recovery remains authoritative. Native tests use only an isolated
task-owned LaunchAgent and opt in explicitly because hosted runners may lack a
GUI domain. Unchanged user research is excluded from the commit.

Spec: native and lifecycle regressions pass. Candidate 1 is now disqualified;
the runtime change requires a new signed candidate and fresh live qualification.
The finite bound does not promise completion of arbitrarily long requests:
interrupted unknown effects must still park. Public release remains blocked.

## Readiness and catch-up follow-up review

Baseline for this slice: `a4991b1a21af2eae4961fcb6fde0896401ca4bb6` (candidate 2).
The live restart check exposed a second blocker: catch-up timed out and left a
new self-chat request unadmitted while daemon status remained ready. Synthetic
public-module and real daemon/journal fixtures reproduced the two symptoms.

Standards: provider retry remains inside the independent Messages module. There
is one scheduled checkpoint retry per subscription, bounded backoff, close-aware
timer cleanup and unchanged generation/age fences. Completed recovery rows retain
their cumulative budget across timeout retries. No provider send or unknown
consumer effect is automatically retried. No raw RPC ownership moves downstream;
the daemon consumes recovery events through its existing adapter. Logs/status
carry only bounded reason codes. Unrelated research and Studio UI work are excluded.

Spec: startup clears stale readiness and waits for subscription; recovery
degradation is durable and is not overwritten by ready. The new retry regression
delivers its pending synthetic message exactly once; close cancels a pending
retry. Recovery success is reported after watch subscription, retaining row
accounting even when the first resubscribe fails. The public action union adds
`retrying-checkpoint`; the documented duration is per attempt, not a guarantee of
overall catch-up completion. Existing row/generation terminal boundaries remain.
Studio's adapter inspects status/reason, not an exhaustive action switch, but its
exact released dependency adoption still needs cross-repo verification. Candidate
2 cannot qualify these runtime changes; signed/live qualification remains open.

Verification: 261 tests passed, one native test skipped by default; typecheck,
build and offline packed-release validation passed. The native active-drain test
passed before this slice and candidate 2's actual active replacement succeeded.
It must still be repeated on the next signed runtime candidate.

Native follow-up: one invocation failed before the synthetic process created its
startup marker within 2.5 seconds; the unchanged rerun drained successfully in
27 seconds. The fixture now allows a bounded 10-second startup wait while keeping
the same active-child completion and unloaded-service assertions. This changes
test startup tolerance, not the product's shutdown deadline.

## Startup qualification budget review

Baseline: `bf21c82556fcb06afb967ec09023d47a50aa92c5`. Candidate 3 truthfully
reported recovery degradation and advanced 7–9 rows per 30-second catch-up
attempt, but the qualification installer's 30-second readiness window expired
and rolled back. The public updater had the same 60 x 500 ms budget.

Standards: change only the bounded readiness poll budget to 600 x 500 ms; do not
accept starting/degraded status, alter identity/signature checks, change provider
recovery limits or advance release state early. Document probe overhead and that
an older updater retains its own older budget. No new retry abstraction.

Spec: the existing updater lifecycle fixture failed with 90 delayed health
checks before the fix and now installs the qualified candidate. The permanently
unready case still rolls back, now asserting exactly 300,000 ms of scheduled
waits. Candidate 3's prior live evidence cannot qualify this runtime change.

## Final qualification-only review

Fixed point: candidate.4 source `549b61db591b6531e4dbb6e4b7a976ad6740d076`.
Scope: qualification evidence and this review only; runtime, tests, manifests,
dependencies and release workflow must remain byte-identical to that source.

Standards: the record contains capability results, versions and artifact hashes,
not participant identifiers, chat keys, handles or private message content.
Unrelated research files are excluded. No signing or publication gate is weakened.

Spec: fresh self-chat context, checkpoint-recovered memory beyond 32 intervening
messages, idle restart, active replacement and participant-originated remote reply
all passed on candidate.4. Journal evidence distinguishes two separately sent
recall requests and confirms a single remote outbound send. The original uncertain
event remains parked, not replayed. The fresh Claude probe matches the recorded
2.1.260 version. All 262 automated tests and offline validation passed; CI repeats
them before public signing/publication. Candidate-to-release changes are docs only.

Summary: Standards 0 unresolved findings; Spec 0 remaining Pronto live release
qualification gaps. This does not qualify Studio's exact-pin integration,
unfinished durable intake or production rollout.
