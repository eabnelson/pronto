# Reliability candidate review

Baseline: `700155e6ce03ad6d51dc498724f4bb6608e209f0`. The remote main update to `04f92a9` was a merge-only commit with no tree difference. Reviewed work: arrival/buffer recovery, reconnect deadlines/backoff, positioned scoped history and candidate-only signing. Standards and Spec reviewed sequentially under the workspace's subagent mapping.

## Standards

The public module remains independent of downstream product code; raw RPC stays internal. The optional position does not create an unscoped capability or replace generation, expiry, routing or cumulative-budget checks. Arrival handling keeps a fixed 256-entry notification buffer and one drain task. Request close-wait listeners are removed after completion; closed subscriptions discard pending memory. These review cleanups resolved resource-lifetime concerns without introducing another queue framework.

Candidate signing reuses the existing protected build job rather than duplicating signing logic. Candidate tags are excluded from automatic release triggers. Manual candidate input fences the entire publish job and update-manifest generation; ordinary releases retain the owner qualification gate and immutable version/tag checks. No credential, Apple identity or npm trust policy was changed. YAML and shell syntax were checked; removal-of-guard regressions pass. No blocking Standards findings remain for the candidate.

## Spec

Regressions cover delayed live callbacks, bounded 10,000-notification recovery, historical age limits, stable versus flapping backoff, reconnect deadline exhaustion without late send submission, synchronous connection-factory failure, and scoped history positions. Existing standalone duplicate, uncertain-effect, shutdown, updater, signature, rollback and Node/Bun compatibility suites remain green. The replay prototype is preserved at `3faa60c` and the proposed ADR records its limitations.

The exact candidate has not completed owner live smoke or signed-to-signed replacement. Historical v0.3.0 evidence cannot qualify changed v0.4.0 transport. Candidate artifacts are for qualification only; the public release gate deliberately still fails for v0.4.0. No real message was sent during local verification. Downstream durable-worker crash-boundary qualification and exact published-version adoption remain separate work, not established by these provider tests.

Summary: Standards 0 unresolved blocking findings; Spec 1 release-blocking qualification gap (fresh signed-candidate owner smoke). Local typecheck/build, 256 tests and offline release validation passed before candidate publication; the protected CI run must independently repeat them.
