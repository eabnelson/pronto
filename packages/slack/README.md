# pronto-slack

A local macOS Slack desktop transport. The provider uses standard ESM and Node interfaces; the native helper retains all session credentials in its own memory. It does not require a Slack developer app, a browser, or a hosted relay.

This is an **unqualified beta candidate**. Installed credential approval, both release architectures, broader conversation types, latency, and long-sleep recovery require the evidence in [Slack qualification](../../docs/SLACK_QUALIFICATION.md) before release. The direct-download desktop profile is the only implemented profile. App Store Slack is excluded.

Build the native helper and compiled CLI with `bun run build` on macOS with Xcode command line tools and Go 1.25.5 or later. Source consumers supply a verified helper path through `createSlackBridge(path)`; the Pronto executable embeds its matching signed helper. No runtime downloads occur.

```js
import { createProntoSlack, createSlackBridge } from "pronto-slack";
const slack = createProntoSlack({
  directory: "/absolute/owner-private/slack-state",
  referenceKey: "an-installation-private-random-key-at-least-32-characters",
  bridge: createSlackBridge("/absolute/verified/slack-helper"),
});
// Discover returns labels and ten-minute opaque handles, never session credentials.
const { workspaces } = await slack.discover();
// Let the owner choose a workspace and accept the consumer's trust disclosure.
// await slack.link(chosenWorkspaceHandle); // explicit interactive Keychain approval
// For workspace-wide coverage after owner consent:
// await slack.useParticipatedConversations();
// linkWorkspace(handle, privateDirectory) connects another workspace separately.
await slack.close();
```

Consumers own consent, selection decisions, tag matching, admission, runtime execution, and durable delivery state. `subscribe` emits only positively eligible human observations within the configured coverage; acknowledge admission only after the consumer has persisted it. Its callback must throw when durable admission fails. Recovery and connection health are separate signals. A healthy socket does not establish complete recovery.

`SlackScope` is a sealed 24-hour reply capability. Scope IDs include workspace, member, conversation, and thread root/timeline without exposing provider IDs. Scope IDs survive renames and relinks to the same identity; capabilities do not survive relinks, deselection/reselection, expiry, or a different installation. Do not send a scope token to a model. Pronto's runtime broker issues separate revocable 20-minute capabilities.

`history(scope, limit)` is bounded to 50 messages and preserves an excerpt of the root for threads. Large threads beyond ten reply pages fail explicitly. Timeline reads exclude nested replies. Files and arbitrary workspace search are unavailable to the agent. `reply` submits once: it returns confirmed, definitively failed, or ambiguous; consumers must never automatically repost ambiguous writes. A durable outbound nonce suppresses exact echoes while preserving genuine owner requests.

Recovery searches for the consumer's configured tags within a 24-hour request-age window and after connection/selection cutoffs. The live-age window is five minutes. It runs at subscription startup, reconnect/wake, settings refresh, and about every sixty seconds. It never enumerates all conversations or walks their histories. A zero-result search leaves owner participation unknown; only canonical positive owner messages grant eligibility.

Pass `tags: () => configuredTags` to `subscribe`, and `isRequest: text => matchesOneConfiguredTag(text)` to filter live traffic and canonical search results with the consumer's tag rules. Untagged owner events may establish participation without being admitted or archived. `onObservation` must resolve only after durable admission; `subscribe` acknowledges automatically after it resolves, and retries unacknowledged work after a failure. Consumers using `observe` directly acknowledge with `acknowledgeObservation` after admission. Manual `reconcile(onObservation, tags, isRequest?)` uses the same focused search path; omitting tags performs no tag searches.

Each pass permits at most five search pages per tag, 50 budgeted provider read operations, 4 MiB of normalized responses, 30 seconds between starting operations, and 100 recovered observations. Search pages hold at most 100 candidates. Canonical lookups pin both timestamp bounds; a hit without thread metadata can resolve its exact reply without scanning old roots. Participation lookup is restricted to the requested conversation and at most three canonical owner checks. Identity verification and native metadata checks can add HTTP requests within a provider operation. A request already in progress can finish after the elapsed-time boundary (25-second native RPC deadline); no next budgeted operation starts past it.

Offline catch-up is best effort, not an exhaustive coverage guarantee: Slack search filters, indexing delay, result grouping, or the bounded result window can omit messages. `recovered` means the bounded search completed without a detected failure; it does not prove that every conversation or offline request was examined. Read/admission failures and exhausted limits report `degraded`. Recovery never falls back to an archive crawl. Native IOKit wake notifications and the live socket operate without the menu bar app. At most 500 conversations are tracked per workspace, with positive participation and revocable scope boundaries preserved.

All native API methods share a 500ms minimum interval (at most 120 starts/minute, without a burst). `Retry-After` blocks subsequent starts; requests waiting over 20 seconds fail as throttled. Socket heartbeat: 15 seconds, 45-second read deadline, five-second control write deadline. Reconnect backoff: 1, 2, 4, 8, 16, 32, 60 seconds. Read/control RPCs expire at 30 seconds; explicit interactive link at 60 seconds. These are local limits, not Slack rate allowances. Reads may require relinking after noninteractive refresh fails; writes are never retried.

Private state stores identity/conversation metadata, cutoffs, dedupe hashes, and outbound nonces, without an ordinary-message archive or plaintext credentials. Atomic fsynced writes use 0700 directories, 0600 files, and a cross-process mutation lock. Selection changes serialize with submitted writes. A write already in progress can settle before removal commits; confirmed memory promotion checks the current generation again.

The Pronto adapter also renders standalone generated `@labels` with an invisible separator. They remain readable but cannot recursively invoke Pronto if an uncertain-send echo lacks Slack's outbound nonce. Email addresses are preserved. This supplements exact nonce/timestamp echo suppression; it does not treat matching text as delivery proof or exclude genuine owner requests.
