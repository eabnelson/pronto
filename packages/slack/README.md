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
// Conversations remain unselected until the owner explicitly selects handles.
await slack.close();
```

Consumers own consent, selection decisions, tag matching, admission, runtime execution, and durable delivery state. `subscribe` emits only selected, positively eligible human observations; acknowledge admission only after the consumer has persisted it. Its callback must throw when durable admission fails. Recovery and connection health are separate signals. A healthy socket does not establish complete recovery.

`SlackScope` is a sealed 24-hour reply capability. Scope IDs include workspace, member, conversation, and thread root/timeline without exposing provider IDs. Scope IDs survive renames and relinks to the same identity; capabilities do not survive relinks, deselection/reselection, expiry, or a different installation. Do not send a scope token to a model. Pronto's runtime broker issues separate revocable 20-minute capabilities.

`history(scope, limit)` is bounded to 50 messages and preserves an excerpt of the root for threads. Large threads beyond ten reply pages fail explicitly. Timeline reads exclude nested replies. Files and arbitrary workspace search are absent. `reply` submits once: it returns confirmed, definitively failed, or ambiguous; consumers must never automatically repost ambiguous writes. A durable outbound nonce suppresses exact echoes while preserving genuine owner requests.

Recovery uses a 24-hour request-age window, five-minute live-age window, and fresh selection cutoffs. Each sweep scans at most 1,000 roots per conversation, 50 relevant threads globally, ten reply pages per thread, 100 history/reply requests, 16 MiB of normalized responses, 90 seconds, and 500 recovered observations across the provider. Pages hold at most 100 messages. A request can finish just after the elapsed-time boundary (25-second helper deadline); no next request starts past the boundary. Budget exhaustion, inaccessible data, and missing continuation cursors remain degraded. No completeness watermark is advanced across gaps. Sixty-second reconciliation supplements the live socket and native IOKit wake callback.

All native API methods share a 500ms minimum interval (at most 120 starts/minute, without a burst). `Retry-After` blocks subsequent starts; requests waiting over 20 seconds fail as throttled. Socket heartbeat: 15 seconds, 45-second read deadline, five-second control write deadline. Reconnect backoff: 1, 2, 4, 8, 16, 32, 60 seconds. Read/control RPCs expire at 30 seconds; explicit interactive link at 60 seconds. These are local limits, not Slack rate allowances. Reads may require relinking after noninteractive refresh fails; writes are never retried.

Private state stores identity/selection metadata, cutoffs, dedupe hashes, and outbound nonces, without an ordinary-message archive or plaintext credentials. Atomic fsynced writes use 0700 directories, 0600 files, and a cross-process mutation lock. Selection changes serialize with submitted writes. A write already in progress can settle before removal commits; confirmed memory promotion checks the current generation again.

The Pronto adapter also renders standalone generated `@labels` with an invisible separator. They remain readable but cannot recursively invoke Pronto if an uncertain-send echo lacks Slack's outbound nonce. Email addresses are preserved. This supplements exact nonce/timestamp echo suppression; it does not treat matching text as delivery proof or exclude genuine owner requests.
