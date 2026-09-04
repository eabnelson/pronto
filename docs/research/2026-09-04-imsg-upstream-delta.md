# `imsg` upstream delta for Pronto 0.2.3

- **Research date:** 2026-09-04
- **Pronto baseline:** [`v0.2.3`](https://github.com/eabnelson/pronto/tree/v0.2.3), commit `8cb7659`
- **Upstream baseline:** [`imsg` v0.14.1](https://github.com/openclaw/imsg/releases/tag/v0.14.1), commit `25beb76`
- **Latest release:** [`imsg` v0.15.0](https://github.com/openclaw/imsg/releases/tag/v0.15.0), commit `f2fad4c`, published 2026-09-04 UTC
- **Upstream `main` inspected:** [`cdc09c1`](https://github.com/openclaw/imsg/tree/cdc09c1f2de8d13bf0052f472b810f35048f1557)

This report compares the official [`v0.14.1...v0.15.0`](https://github.com/openclaw/imsg/compare/v0.14.1...v0.15.0) change set and the unreleased [`v0.15.0...cdc09c1`](https://github.com/openclaw/imsg/compare/v0.15.0...cdc09c1f2de8d13bf0052f472b810f35048f1557) changes with Pronto's local Messages module. It uses upstream release notes, documentation, source, and tests plus the local Pronto source; it does not treat untagged upstream code as a releasable dependency.

## Bottom line

`imsg` v0.15.0 does not break Pronto's current public read/watch/send contract. RPC remains protocol version 1, every method Pronto requires remains available in SIP-on mode when `chat.db` is readable, request keys and core response fields are unchanged, and the new fields/methods are additive. Pronto's capability-based qualifier is therefore structurally compatible with v0.15.0 ([Pronto qualifier](../../packages/messages/src/internal/normalize.ts#L8-L52), [`imsg` status contract](https://github.com/openclaw/imsg/blob/v0.15.0/docs/rpc.md#status)).

It is not yet production-qualified. Pronto v0.2.3's evidence matrix covers `imsg` 0.14.1 only ([release qualification](../RELEASE_QUALIFICATION.md#current-matrix)). More importantly, upstream `main` gained twelve fixes immediately after v0.15.0, including watch replay, attributed-body decoding, physical-message cardinality, subscription cleanup, and send-route verification. Those are precisely the surfaces Pronto uses. Prefer the next signed release containing those fixes; if v0.15.0 must ship first, run the focused live and synthetic matrix below and record the known gap explicitly.

## Priority summary

| Priority | Recommendation | Why |
| --- | --- | --- |
| Must | Keep 0.14.1 as the recorded production-qualified version until an exact v0.15.0/next-release matrix passes | Source compatibility is not live evidence, and post-tag fixes touch Pronto-critical paths |
| Must | Fix Pronto's RPC error-data mapping | Upstream uses `retryable` for database/bridge availability but Pronto checks only `retry_safe` |
| Must | Honor upstream's EOF drain instead of immediately sending `SIGTERM` | Current shutdown can interrupt an accepted mutation and manufacture ambiguity |
| Must | Separate message-level `destination_caller_id` from chat-level `last_addressed_handle` | Pronto currently drops the stronger per-message routing fact |
| Must | Correct the zero-cursor handoff and stale-row recovery behavior | `messages.after(0)` and `watch.subscribe(0)` have different meanings; the current age abort can skip newer eligible rows |
| Should | Add exact v0.14.2+ direct-chat recovery coverage | The fix benefits Pronto's `chat_id` text and attachment replies without an API change |
| Should | Preserve a richer capability/diagnostic snapshot and bounded sanitized stderr | Optional features must follow current readiness; today stderr is discarded |
| Should | Harden group evidence for downstream consumers | `is_group` is identifier-shape-derived; external participant evidence should prevent unsafe direct-chat classification |
| Defer | `send.tracked`, private bridge actions, contact names, chat creation, polls, and SSH transport | They either require a new security/effect contract or do not serve Pronto's current product path |

## Compatibility after v0.14.1

### Compatible and beneficial

- **v0.14.2 direct-chat recovery:** a direct conversation missing from Messages.app's live cache can be recovered only through one database-verified participant on the original account and service. The behavior also applies when a direct chat is selected by `chat_id`, `chat_guid`, or `chat_identifier`; groups and unverified targets do not use it ([implementation](https://github.com/openclaw/imsg/commit/7c55ba5e79f1b70052e38991d4cadbd0d34c7836), [send contract](https://github.com/openclaw/imsg/blob/v0.15.0/docs/send.md#direct-sends)). Pronto already sends replies by exact `chat_id` in [`reply`](../../packages/messages/src/index.ts#L555-L583), so this is a transparent reliability improvement.
- **Headless Contacts behavior:** v0.14.2 prevents noninteractive watch/search startup from waiting on an unresolved Contacts prompt; v0.15.0 adds read-only AddressBook resolution over SSH with Full Disk Access ([v0.15.0 release](https://github.com/openclaw/imsg/releases/tag/v0.15.0), [permissions](https://github.com/openclaw/imsg/blob/v0.15.0/docs/permissions.md#contacts-over-ssh)). Pronto routes on IDs, GUIDs, account metadata, and handles rather than contact names, so the added names are non-authoritative and harmless.
- **Chat-name schema refinement:** `chats.list.name` is now a Messages title or raw identifier fallback; a resolved person name stays in `contact_name` ([change](https://github.com/openclaw/imsg/commit/c1bc060305f192a15fefe080283bea84c3f9189a)). Pronto ignores both fields and continues to use `id`, `guid`, `account_id`, `account_login`, `last_addressed_handle`, and participants.
- **Dynamic capability status:** v0.15.0 reports a hung injected helper as unavailable and only advertises `send.tracked` when the database and `clientMessageGuidReservation` selector are ready ([descriptor](https://github.com/openclaw/imsg/blob/v0.15.0/Sources/imsg/RPCMethodDescriptors.swift#L107-L139), [status semantics](https://github.com/openclaw/imsg/blob/v0.15.0/docs/rpc.md#status)). Pronto correctly validates `status.methods`, not `supported_methods`, and tolerates additive methods.
- **Poll-caption result fields and first-contact group creation** are additive bridge-only behavior. They do not change Pronto's public RPC requests or response parsing ([v0.15.0 RPC](https://github.com/openclaw/imsg/blob/v0.15.0/docs/rpc.md)).

### No automatic version blocker inside Pronto

Pronto's README deliberately permits “0.14 or a capability-compatible release,” and [`qualify`](../../packages/messages/src/internal/normalize.ts#L26-L52) checks protocol, current methods, database readiness, routing metadata, and optional database features rather than an exact version. That is the right compatibility boundary. The remaining 0.14.1 reference is evidence, not a runtime pin, and should change only after qualification.

## Must fix in Pronto

### 1. Map upstream retryability fields correctly

Pronto's [`reply`](../../packages/messages/src/index.ts#L555-L583) interprets delivery failures correctly when `data.disposition` and `data.retry_safe` are present. It treats every other RPC error as retryable only when `data.retry_safe === true`.

Upstream uses two schemas:

- Transport delivery failures carry `retry_safe` plus `not_started`, `may_have_completed`, or `still_in_flight`.
- Availability failures such as database unavailable (`-32002`) and bridge unavailable (`-32003`) carry `retryable: true`, not `retry_safe` ([upstream error construction](https://github.com/openclaw/imsg/blob/v0.15.0/Sources/imsg/RPCServer%2BSupport.swift#L80-L135)). An exact `chat_id` send requires the database, so `-32002` occurs before dispatch and is safe to retry after the database recovers ([send contract](https://github.com/openclaw/imsg/blob/v0.15.0/docs/rpc.md#send)).

Pronto 0.2.3 therefore reports a provider-declared retryable database outage as `{status:"failed", retryable:false}`. Map typed delivery disposition first; then map `data.retryable === true` for the documented availability codes. Treat `-32000` server-busy as a bounded-backoff retry only when it is the response to Pronto's request: upstream rejects excess identified work before admission ([runtime test](https://github.com/openclaw/imsg/blob/v0.15.0/Tests/imsgTests/RPCRuntimeTests.swift#L401-L429)). Keep all unknown errors non-retryable.

### 2. Let normal EOF drain accepted work

`imsg rpc` stops admitting work when stdin closes, cancels and awaits subscriptions, drains already accepted requests—including queued mutations—and flushes stdout before exiting ([lifecycle](https://github.com/openclaw/imsg/blob/v0.15.0/docs/rpc.md#lifecycle)). Pronto's [`ImsgRpcClient.close`](../../packages/messages/src/internal/rpc.ts#L112-L118) closes stdin and immediately sends `SIGTERM`. That defeats the upstream guarantee and can turn a controlled daemon stop or update into an avoidable ambiguous send.

End stdin, wait a short bounded grace period for exit and final responses, then escalate to `SIGTERM` and `SIGKILL`. A test should keep a mutation pending across EOF, prove its final response is consumed, and separately prove a hung child cannot block shutdown. Preserve the existing no-replay behavior for any response that is actually lost.

### 3. Preserve the actual local routing fact

`imsg` distinguishes chat-level routing diagnostics (`account_id`, `account_login`, `last_addressed_handle`) from the outbound message's `destination_caller_id`, which says which local number Messages actually used ([group/routing model](https://github.com/openclaw/imsg/blob/v0.15.0/docs/groups.md#participants-exclude-the-local-user)).

Pronto currently derives `routing.destinationHandle` from `chat.last_addressed_handle` and does not carry `message.destination_caller_id` into `MessagesEvent` ([normalization](../../packages/messages/src/internal/normalize.ts#L81-L127), [public types](../../packages/messages/src/types.ts#L16-L69)). Split these fields. Keep the chat hint for route diagnostics; add the nullable message-level destination caller ID as the only evidence of the alias used for that outbound row. Consumers must not present the chat hint as positive message-level identity proof.

### 4. Correct cursor-zero and age-bound semantics

`messages.after` defines `since_rowid: 0` as “read after row zero.” `watch.subscribe` defines an omitted or zero cursor as “start at the current tail”; `-1` explicitly replays from the beginning ([current RPC docs](https://github.com/openclaw/imsg/blob/cdc09c1f2de8d13bf0052f472b810f35048f1557/docs/rpc.md#messagesafter), [watch cursor docs](https://github.com/openclaw/imsg/blob/cdc09c1f2de8d13bf0052f472b810f35048f1557/docs/rpc.md#watchsubscribe)).

Pronto permits an adopted checkpoint at row zero and passes that same zero to both `messages.after` and `watch.subscribe` ([checkpoint adoption](../../packages/messages/src/index.ts#L186-L238), [subscription request](../../packages/messages/src/index.ts#L297-L315)). If the database is empty during catch-up and a row lands before subscribe, the watch's zero-as-tail behavior can skip it. Translate a logical replay-from-start checkpoint to `-1` at the watch boundary, or atomically establish a positive high-water handoff; keep zero for `messages.after`.

The related recovery age policy also needs correction. Pronto applies `maxAgeMs` only during catch-up, and the first old row aborts the entire pass into live-only mode ([catch-up](../../packages/messages/src/index.ts#L745-L825)). That can hide a newer eligible row behind an old one. Skip and advance/tombstone individual stale rows within a bounded scan rather than abandoning all later rows, and add a separate age fence for live notifications in the [`handleNotification`](../../packages/messages/src/index.ts#L472-L518) path. Missing/invalid dates should produce a safe diagnostic, not be treated as fresh.

## Latest-release caution: upstream `main` is already ahead

The latest signed release is v0.15.0, but upstream `main` at `cdc09c1` contains twelve later commits dated September 4. Five groups intersect Pronto directly:

1. [`2d64721`](https://github.com/openclaw/imsg/commit/2d64721d307e80221d1e033938a710e42417b529) preserves watch replay state across unresolved-chat retries and actively drains bounded backlog instead of waiting for another filesystem event or fallback poll.
2. [`1401843`](https://github.com/openclaw/imsg/commit/1401843c90d23cf76be52e92a854de7f8f0e0dec) makes each physical message appear once across multi-chat joins and preserves explicit-chat context.
3. [`d39f914`](https://github.com/openclaw/imsg/commit/d39f914f293f66d9b310a032c941e689b74897c0) fixes attributed-body decoding with native length framing, including Unicode, leading line breaks, long text, and malformed input. Pronto's tag activation depends on the decoded `text` field.
4. [`6b7ca26`](https://github.com/openclaw/imsg/commit/6b7ca263d92af35274e5c916eb57528b980b2cc3) retains subscription ownership until cancellation cleanup completes, reinforcing the documented “no notification after unsubscribe response” contract.
5. [`cdc09c1`](https://github.com/openclaw/imsg/commit/cdc09c1f2de8d13bf0052f472b810f35048f1557) verifies AppleScript sends against the resolved delivery route, including service and SMS fallback, before returning the GUID that Pronto maps to `confirmed`.

These commits do not prove every bug reproduces through Pronto's exact `chat_id` flow. They do prove the released code was changed immediately afterward in Pronto-critical areas. Do not install untagged `main` on production Macs; wait for a signed/notarized release containing the fixes, or qualify v0.15.0 with targeted regression cases and state the residual risk.

## Should adopt

### Exact direct-chat recovery test

Add a provider contract fixture and owner smoke where an exact direct `chat_id` exists in `chat.db` but is absent from Messages.app's live cache. Verify one text send and one file send stay on the original account/service, never use group recovery, and preserve the existing ambiguous/no-retry result when dispatch cannot be proved. This exercises v0.14.2's main benefit to Pronto.

### Capability and diagnostics snapshot

Pronto correctly gates core behavior on current `status.methods`; keep that. Its public [`MessagesQualification`](../../packages/messages/src/types.ts#L76-L81), however, discards the method list, `supported_methods`, contacts state, and bridge selectors. Retain a sanitized snapshot so optional features can be gated on current readiness and re-probed after child restart. `supported_methods` is only the compiled union; it must never authorize an action.

Pronto currently discards all child stderr with `.resume()` ([RPC spawn](../../packages/messages/src/internal/rpc.ts#L56-L66)). Upstream reserves stderr for diagnostics and documents a benign Contacts-framework message that parents should not misreport ([transport](https://github.com/openclaw/imsg/blob/v0.15.0/docs/rpc.md#transport), [Contacts note](https://github.com/openclaw/imsg/blob/v0.15.0/docs/permissions.md#contacts-optional)). Capture only known/redacted reason codes or a small sanitized ring. Do not persist raw paths, names, handles, or message content.

### Group classification evidence for consumers

Upstream derives `is_group` from whether the chat identifier/GUID contains `;+;`, while `participants` contains external handles only ([group model](https://github.com/openclaw/imsg/blob/v0.15.0/docs/groups.md#what-counts-as-a-group)). Pronto exposes only one `isGroup` boolean in `ConversationFacts`. The standalone Pronto product still requires a tag everywhere, so this does not currently widen its activation policy; library consumers may make different direct/group authorization decisions.

Expose the raw classification evidence or a `direct | group | ambiguous` result. More than one external participant or conflicting chat/message evidence must never be silently downgraded to a permissive direct-chat policy. Keep exact account plus conversation GUID as the route identity.

## Defer

### `send.tracked`

v0.14.2 added caller-owned UUID sends that can be reconciled through `message.send_status`, but they are text-only, require a readable database and the injected IMCore bridge, and never fall back to AppleScript ([contract](https://github.com/openclaw/imsg/blob/v0.15.0/docs/rpc.md#sendtracked)). Pronto's stated default is SIP-on public read/watch/send ([README](../../README.md#requirements)); do not weaken that posture merely to gain reconciliation.

If a separately consented private transport is ever designed, it needs a durable UUID attempt ID, runtime gating on both `send.tracked` and `message.send_status`, post-reconnect reconciliation, and a change to [`ImsgRpcClient`](../../packages/messages/src/internal/rpc.ts#L79-L108), which currently treats only the literal method `send` as submission-uncertain. A missing status row is not authorization to resend. Keep ordinary `send` for SMS/RCS and attachments.

### SSH transport

v0.15.0's SSH contact resolution does not make Pronto remote-compatible. Pronto reads the database path returned by remote RPC and computes the generation with local `realpath` and `stat`, hashing local path/device/inode/birth time ([qualification](../../packages/messages/src/index.ts#L165-L172), [generation identity](../../packages/messages/src/internal/generation.ts#L4-L42)). Remote attachment paths also cannot be materialized as local files. Keep Pronto and `imsg` on the same Mac unless a separate remote-generation token, pinned host identity, and authenticated attachment-staging protocol are designed.

### Bridge-only feature additions

First-contact chat creation, group mutation, poll send/vote, typing, receipts, edit/unsend, and other rich actions require new user authority and effect semantics. Poll creation is specifically multi-effect: `ok: true` may accompany a failed or unknown text caption, and retrying `poll.send` would duplicate the poll ([poll result contract](https://github.com/openclaw/imsg/blob/v0.15.0/docs/rpc.md#polls)). Contact display names must remain presentation-only and never enter authorization.

## Qualification matrix for the next `imsg` target

- Protocol v1 and all current required `status.methods` are present; extra methods do not fail qualification.
- Headless startup produces no Contacts prompt and no non-JSON stdout.
- Normal message, attributed-body Unicode message, attachment-only message, reaction, poll row, and URL-preview coalescing preserve one monotonic cursor.
- An unresolved-chat retry followed by more rows loses nothing; a backlog larger than one watcher batch drains without another filesystem event.
- Overflow's `resume_after_rowid` plus `messages.after` produces no skipped activation.
- A row arriving between zero-checkpoint catch-up and watch subscribe is delivered exactly once.
- Old recovery rows do not hide newer eligible rows; stale live rows never activate.
- Direct `chat_id` recovery stays on the original account/service for both text and file.
- `not_started`, `may_have_completed`, `still_in_flight`, `-32000`, and `-32002` map to the intended Pronto result without an unsafe resend.
- EOF drains an accepted send; forced termination still bounds a hung child.
- A confirmed reply GUID belongs to the exact resolved chat/service; a missing GUID remains ambiguous.
- Database replacement invalidates the old generation/cursor; attachment references cannot cross the generation boundary.

## Primary sources

- [`imsg` v0.15.0 release](https://github.com/openclaw/imsg/releases/tag/v0.15.0), [`v0.14.1...v0.15.0`](https://github.com/openclaw/imsg/compare/v0.14.1...v0.15.0), [RPC](https://github.com/openclaw/imsg/blob/v0.15.0/docs/rpc.md), [watch](https://github.com/openclaw/imsg/blob/v0.15.0/docs/watch.md), [send](https://github.com/openclaw/imsg/blob/v0.15.0/docs/send.md), [groups](https://github.com/openclaw/imsg/blob/v0.15.0/docs/groups.md), and [permissions](https://github.com/openclaw/imsg/blob/v0.15.0/docs/permissions.md).
- [`imsg` current `main` snapshot](https://github.com/openclaw/imsg/tree/cdc09c1f2de8d13bf0052f472b810f35048f1557) and [`v0.15.0...cdc09c1`](https://github.com/openclaw/imsg/compare/v0.15.0...cdc09c1f2de8d13bf0052f472b810f35048f1557).
- [Pronto v0.2.3 Messages module](https://github.com/eabnelson/pronto/tree/v0.2.3/packages/messages), plus the local files linked throughout this report.
