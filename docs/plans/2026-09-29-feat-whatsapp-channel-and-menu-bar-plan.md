---
title: WhatsApp Channel and Menu Bar Status - Plan
type: feat
date: 2026-09-29
topic: whatsapp-channel-and-menu-bar
artifact_contract: ce-unified-plan/v1
artifact_readiness: draft
product_contract_source: session
execution: code
---

# WhatsApp Channel and Menu Bar Status - Plan

## Goal Capsule

- **Objective:** Let an installer choose iMessage, WhatsApp, or both, pick trigger tags for each, and have tagged messages answered in the same conversation from the installer's own account. Ship a macOS menu bar app that shows connected channels, their health, their tags, and pending updates, and allows tags and channels to be changed without a terminal.
- **Product authority:** This contract owns the channel model, the WhatsApp channel, per-channel tags, the machine-readable control surface of the `pronto` CLI, and the menu bar app.
- **Open blockers:** Phase 0 spike results (see Validation Spike).

---

## Product Contract

### Summary

Pronto becomes a multi-channel listener. iMessage keeps working exactly as today through `imsg`. WhatsApp is added through [`wacli`](https://github.com/openclaw/wacli), a sibling OpenClaw CLI that pairs as a WhatsApp linked device using `whatsmeow`. One daemon runs every enabled channel, with shared turn processing, memory, workspaces, and runtimes. A new native menu bar app is a thin UI over `pronto ... --json` commands.

### Problem Frame

Pronto is hardwired to Apple Messages: `ActivatedRequest`, `ConversationReference`, and `MessagesEvent` come from `pronto-imessage` and are keyed by a numeric `chatId`; `activation.ts` accepts only `imessage`/`rcs` services; `ProntoDaemon` constructs `ImsgTransport` directly; config has a single global `tags` list and an `imsgPath`. The only seam is `TurnTransport` (`packages/cli/src/core/turn.ts`). Users on WhatsApp cannot use Pronto, and all health and tag management requires a terminal.

### Actors

- A1. The installer chooses channels, links WhatsApp, and picks tags per channel.
- A2. A participant in an eligible conversation writes a tagged message.
- A3. The daemon runs Claude Code or Codex and replies from the installer's account in the same conversation.
- A4. The menu bar app observes and edits configuration through the CLI.

### Key Decisions

- **WhatsApp uses `wacli`, accepting protocol-level risk** (session-settled: user-approved — chosen over reading WhatsApp Desktop's `ChatStorage.sqlite` plus UI automation for sending: the automation path steals focus, cannot reliably address groups, and cannot do typing or reactions). `whatsmeow` is an unofficial WhatsApp Web implementation and use is subject to WhatsApp's terms; setup must disclose this and record consent.
- **WhatsApp follows every iMessage activation rule** (session-settled: user-directed — chosen over a stricter owner-only default for WhatsApp). The rules are listed in R6a; WhatsApp deviates only where it technically cannot match iMessage, and each deviation is named.
- **Each tag is assigned to one or more apps** (session-settled: user-directed). Adding a tag requires choosing its apps, and when both apps are enabled, both are selected by default. Storage stays per channel (`channels.<app>.tags`), and the UI presents one tag list with app badges.
- **The menu bar app ships inside Pronto's signed update** (session-settled: user-approved — chosen over a separate Sparkle updater: one trust chain and one install transaction).
- **One daemon, many channels** — chosen over one LaunchAgent per channel: runtimes, memory, the broker, and workspace state are shared, and one health record per channel is simpler to present. A failing channel must not stop other channels.
- **The menu bar app holds no messaging permissions** — chosen over embedding the daemon in an app bundle: it never needs Full Disk Access or a WhatsApp session; it only executes the installed, signature-verified `pronto` binary with `--json` and renders the result. The daemon's Full Disk Access identity is unchanged.
- **WhatsApp ships as its own published module, `pronto-whatsapp`** (session-settled: user-directed — chosen over keeping WhatsApp mechanics private to the CLI: other products should be able to add WhatsApp as easily as they add iMessage). It lives in `packages/whatsapp`, follows the ADR 0001 module contract (provider mechanics inside, consumer policy outside), and is released, attested, and exact-pinned in the same way as `pronto-imessage`.
- **Provider-neutral code only where two real providers need it.** ADR 0001 declined a "speculative provider-neutral framework". A second real provider now exists, so a new ADR (0007) records two things: `pronto-whatsapp` as a second module, and a `Channel` interface in `packages/cli` that adapts both modules for the standalone product. The two modules share no runtime code and do not depend on each other; each keeps its own provider-native types.

### Requirements

**Channel selection and setup**

- R1. `pronto setup` must ask which channels to enable (iMessage, WhatsApp, or both), defaulting to iMessage for existing installs and to every detected channel for fresh installs.
- R2. iMessage prerequisites (`imsg` on PATH, Full Disk Access) are required only when iMessage is enabled. A WhatsApp-only install must not ask for Full Disk Access.
- R3. Enabling WhatsApp must require `wacli` at or above a pinned minimum version, show the unofficial-protocol disclosure, record `whatsappRiskConsentVersion`, and link a device (QR, or phone-number pairing code).
- R4. Setup must prompt for tags, defaulting to the previously configured tags (`["@s4"]` on a fresh install), and then for each tag ask which apps it applies to. When both apps are enabled the default is both; when only one is enabled, no question is asked.
- R4a. Every path that adds a tag (setup, `pronto tags add`, the menu bar) must make the app selection explicit, defaulting to all enabled apps.
- R5. Existing v2 configs must migrate to v3 without user action: `tags` and `imsgPath` become `channels.imessage`, which stays enabled.

**WhatsApp behavior parity**

- R6. A tagged WhatsApp message in a direct or group chat must produce one reply in the same chat, sent from the installer's account, quoting the triggering message.
- R6a. WhatsApp activation must apply the same rules as iMessage (`activatedRequest` in `packages/cli/src/activation.ts` and the limits in `pronto-imessage`):
  - Any participant can trigger in a conversation where the installer has sent at least one message (`ownerParticipated`). For WhatsApp this is checked with `wacli messages list --chat JID --from-me --limit 1 --json`. WhatsApp history is best-effort, so a chat whose earlier sends were never synced counts as not participated until the installer sends a message there.
  - Exactly one distinct configured tag must match, with word boundaries anywhere in the text; the tag is stripped, and an empty remainder becomes "Help with this conversation." (`removeOneMatchedTag`, shared code).
  - Only ordinary messages with text are eligible.
  - Live events older than 5 minutes on arrival are suppressed (`maxLiveAgeMs`). Messages recovered after a disconnect are answered if younger than 24 hours (`maxAgeMs`).
  - Scoped history access for the agent uses the same 24-hour scope TTL (`STANDALONE_SCOPE_TTL_MS`).
  - Unknown send outcomes are ambiguous and are never retried.
- R7. Messages the installer types on the phone or another device must be able to trigger the agent (`wacli` sync imports them with `FromMe=true`).
- R8. Pronto's own replies must never re-trigger it, even if the reply text contains a tag.
- R9. WhatsApp-only kinds with no iMessage equivalent must never trigger: status broadcasts and `@newsletter` channels. Reactions, edits, deletions, and media without a caption are not ordinary text messages and so do not trigger, as in iMessage. A caption may trigger. The "Message yourself" chat follows iMessage self-chat behavior only if Phase 0 shows that `wacli send --allow-self` delivers reliably; `wacli` documents that such sends may be acknowledged without being delivered, and if that is confirmed, self-chat is excluded as a named deviation.
- R10. A send whose outcome is unknown must be recorded as ambiguous and never retried, matching the iMessage journal contract.
- R11. While a turn runs, WhatsApp must show a typing indicator in that chat; it must be cleared when the turn settles.
- R12. Age limits must match iMessage (R6a). The webhook cannot tell live messages from replayed ones, so webhook payloads are treated as live (5-minute limit). The reconciliation sweep after `offline_sync_completed` or a restart is treated as recovery (24-hour limit), so tags missed while the Mac slept are still answered, as in iMessage.
- R13. Replies must use WhatsApp formatting (`*bold*`, `_italic_`, `~strike~`, ```` ``` ```` monospace) rather than iMessage plain-text formatting.

**Operations and control surface**

- R14. `pronto status --json` must report the listener, daemon, and a per-channel record: `enabled`, `state` (`ready | starting | degraded | failed | needs_link | disabled`), `reason`, `tags`, `lastActivationAt`, `lastReplyAt`, and dependency version. It must stay content-free.
- R15. Tag and channel changes must take effect without restarting the whole listener; the daemon reloads config on `SIGHUP`, and a failed reload keeps the previous config.
- R16. `pronto doctor --json` must run per-channel checks. WhatsApp checks: `wacli` version, `auth status`, follow-process liveness, webhook receipt, and the heartbeat age from `wacli doctor --json`.
- R17. `pronto update --check --json` must report the installed and available Pronto version and whether the Full Disk Access identity would change. Status must also report whether `imsg` and `wacli` are below the supported floor.

**Menu bar**

- R18. The menu bar icon must summarize health: normal when every enabled channel is ready, attention when degraded or an update is available, error when the listener is stopped or any enabled channel failed or needs linking, and dimmed when paused.
- R19. The menu must list each app with its state and last reply time, and list tags with badges showing their apps. It must allow adding a tag (with app checkboxes, all enabled apps checked by default), changing a tag's apps, removing a tag, enabling and disabling apps, linking WhatsApp, pausing and resuming the listener, running doctor, and installing a Pronto update.
- R20. The menu bar app must execute only the installed `pronto` at `~/Library/Application Support/pronto/bin/pronto` after verifying its designated requirement matches the Pronto Team ID, and must never display message content.
- R21. The menu bar app must start at login (`SMAppService.mainApp`) when the user opts in, and quitting it must not stop the listener.

---

## Architecture

### Channel interface (`packages/cli/src/channels/`)

```ts
export type ChannelKind = "imessage" | "whatsapp";

export type ChannelConversation =
  | { channel: "imessage"; chatId: number; reference: ConversationReference }
  | { channel: "whatsapp"; chatJid: string; isGroup: boolean };

export interface ChannelActivation {
  channel: ChannelKind;
  conversation: ChannelConversation;
  providerGuid: string;          // namespaced, see Storage
  providerMessageId: string;     // native id, used for quoting and reactions
  senderId: string | null;
  isFromMe: boolean;
  activationTag: string;
  request: string;
  occurredAt: string;
}

export interface Channel {
  readonly kind: ChannelKind;
  qualify(): Promise<ChannelQualification>;          // { degraded: string[] }
  watch(options: {
    tags: readonly string[];
    onActivation(activation: ChannelActivation): void;
    onHealth(health: ChannelHealth): void;
  }): Promise<{ close(): Promise<void>; setTags(tags: readonly string[]): void }>;
  recentMessages(conversation: ChannelConversation, limit?: number): Promise<unknown[]>;
  sendText(
    conversation: ChannelConversation,
    text: string,
    options?: { quote?: { providerMessageId: string; senderId: string | null } },
  ): Promise<SendDisposition>;
  setTyping?(conversation: ChannelConversation, on: boolean): Promise<void>;
  formatReply(text: string): string;
}
```

- `ImessageChannel` wraps the existing `ImsgTransport`, `ImsgCurrentChatSource`, `formatImessageReplyText`, and `activatedRequest`. There is no behavior change.
- `TurnTransport` becomes a lookup: `TurnProcessor` picks the `Channel` from `event.conversation.channel`.
- `WhatsappChannel` wraps `pronto-whatsapp` in the same way. `ConversationBroker` / `current-chat-source` gain a `WhatsappCurrentChatSource` backed by the module's scoped `history()`.
- Activation splits in two: `removeOneMatchedTag` (shared, unchanged) and a per-channel eligibility predicate that answers the same questions for each app: did the owner participate, is this an ordinary text message, is it a self-chat mirror, is it within the age limit. iMessage keeps its current predicate. WhatsApp implements the same checks (R6a, R9). The age limits are shared constants, not per-channel settings.

### `pronto-whatsapp` module (`packages/whatsapp/`)

The module mirrors `pronto-imessage`: one in-process library that owns the WhatsApp mechanics and exposes normalized facts and commands without consumer policy. It knows nothing about tags, runtimes, the delivery journal, or Pronto config. Its public surface deliberately mirrors `ProntoMessages` so a consumer that knows one module can pick up the other quickly:

```ts
import { createProntoWhatsapp } from "pronto-whatsapp";

const whatsapp = createProntoWhatsapp({
  wacliPath: "/opt/homebrew/bin/wacli",
  storeDir,                  // consumer-owned, private (0700)
  statePath,                 // module checkpoint: watermark and recovery state
  referenceKey,              // HMAC key for opaque conversation references
  recoveryLimits: { maxLiveAgeMs: 5 * 60_000, maxAgeMs: 24 * 60 * 60_000 },
  scopeLimits: { ttlMs: 24 * 60 * 60_000 },
  presence: true,            // optional typing and reactions
});

await whatsapp.qualify();                      // version floor + capabilities
const sub = await whatsapp.subscribe({
  onEvent(event) {},                           // WhatsappEvent: message + conversation facts
  onRecovery(outcome) {},                      // live vs recovered, degraded reasons
  onHealth(health) {},                         // connected | stale | needs_link | failed
});
await whatsapp.history(conversation, { limit: 20 }); // scoped to observed conversations
await whatsapp.reply(conversation, { text, quote });  // confirmed | ambiguous | failed
await whatsapp.presence.setTyping(conversation, true);
await whatsapp.presence.react(conversation, target, "👍");
for await (const step of whatsapp.link({ phone })) {} // qr | pairing_code | linked | failed
await whatsapp.unlink();
await whatsapp.close();
```

The module owns:
- supervising the `wacli` process;
- the loopback webhook and signature checks;
- turning payloads into events, with `conversationFacts.ownerParticipated`, group shape, and exclusion of status broadcasts and newsletters;
- the live and recovery age limits, the watermark checkpoint, and recovery sweeps;
- scoped history (ADR 0003 and 0005 applied to WhatsApp);
- send outcomes, presence, and the linking stream.

Default limits equal the `pronto-imessage` defaults, so iMessage parity (R6a) holds by construction. The consumer owns activation and tags, echo suppression through its journal, and every product decision.

Package specifics:
- **Package.** `pronto-whatsapp` in `packages/whatsapp`, MIT, built with `tsc` like `packages/messages`, and published by the same release workflow with the same checksum, attestation, and npm provenance steps. `docs/UPDATES.md` gains the new release surface.
- **Versioning.** Both modules are released at the repository version, which the existing release tooling already enforces for `pronto-imessage`. `pronto` uses both through the workspace. The module declares its supported `wacli` floor and exposes it for consumers' doctor output.
- **Tests.** `packages/whatsapp/test` has its own fake `wacli` fixture, so the module is testable without the CLI.
- **README.** Covers install (`brew install openclaw/tap/wacli`, `npm i pronto-whatsapp`), linking, a 20-line echo-bot example, the unofficial-protocol disclosure, and the ownership boundary.

#### Mechanics

`wacli` owns the WhatsApp session. The module supervises one long-running child per instance, in the same way that `ResilientRpcClient` supervises `imsg rpc`:

```sh
wacli --store "$APP_SUPPORT/whatsapp" sync --follow \
  --events \
  --presence-mode quiet \
  --max-reconnect 0 --stale-threshold 90s \
  --max-db-size 2GB \
  --webhook "http://127.0.0.1:$PORT/whatsapp" --webhook-allow-private \
  --webhook-secret "$PER_START_SECRET" \
  --webhook-events message
```

- **Store isolation.** The consumer supplies `storeDir`. Pronto uses `~/Library/Application Support/pronto/whatsapp/` (mode 0700), so it never collides with a user's personal `~/.wacli`.
- **Inbound.** The module binds a loopback-only HTTP listener on an ephemeral port, verifies `X-Wacli-Signature` with a secret generated at each start, and normalizes payloads (`Chat`, `ID`, `SenderJID`, `Timestamp`, `FromMe`, `Text`, `Media.Caption`). Webhook payloads use the live 5-minute age limit. Webhook delivery is best-effort, so startup and the `--events` `offline_sync_completed` event trigger a recovery sweep (`wacli messages list --after <max(watermark, now − 24h)> --json`) that uses the 24-hour recovery limit. A live sweep also runs every five minutes while the channel is ready. The module deduplicates within its checkpoint, and Pronto's journal primary key makes any remaining duplicates harmless.
- **Outbound.** `wacli --store … send text --to JID --message TEXT --reply-to ID [--reply-to-sender JID] --json`. While `sync --follow` runs, `wacli` delegates this to the follow process through its local socket, so no second session opens.
  - `sent: true` with an `id` → `confirmed`, including when `store_warning` is present.
  - An error that `wacli` reports as not dispatched → `failed`.
  - A timeout, non-JSON output, or a crash → `ambiguous`.
- **Echo suppression (consumer).** Before sending, Pronto records `(channel, chatJid, text)` via `journal.matchesOutboundEcho`, then bind the returned `id`. Incoming `FromMe` messages whose ID or pending text matches are dropped (R8).
- **Presence.** `wacli presence typing|paused --to JID` around turns (R11). An optional acknowledgment reaction via `send react` is off by default, to mirror ADR 0006.
- **Linking.** `link()` runs `wacli auth --events --qr-format text` and yields QR and pairing-code steps. `pronto whatsapp link [--phone NUMBER] [--events]` drives it. The terminal renders the QR; `--events` passes raw QR and pairing-code events through for the menu bar. `pronto whatsapp unlink` runs `auth logout`. A `logged_out` event moves the channel to `needs_link`, and the menu bar and `status` surface it.
- **Health.** Map `--events` (`connected`, `stale`, `logged_out`, warnings) together with process exit and `wacli doctor --json` `store.last_activity_at` onto `ChannelHealth`.
- **Qualification.** `wacli version --json` must be at or above the pinned floor. Required capabilities: `sync --webhook`, delegated `send text --json`, `--reply-to`, `presence`, `messages list --json`. A missing capability is `failed` for the core path and `degraded` for presence.

### Configuration (v3)

```jsonc
{
  "version": 3,
  "chatKeySalt": "…",
  "primaryRuntime": "claude",
  "fallbackRuntime": "codex",
  "workingDirectory": "/Users/me/pronto",
  "unrestrictedTrustVersion": 1,
  "channels": {
    "imessage": { "enabled": true,  "tags": ["@s4"], "imsgPath": "/opt/homebrew/bin/imsg" },
    "whatsapp": { "enabled": true,  "tags": ["@s4", "@wa"], "wacliPath": "/opt/homebrew/bin/wacli",
                  "riskConsentVersion": 1 }
  }
}
```

- `loadConfig` accepts v1, v2, and v3. v1 and v2 migrate in memory, and the file is rewritten atomically on the next save.
- At least one channel must be enabled, and every enabled channel needs at least one tag. `removeTag` enforces this per channel.
- `normalizeTag` / `TAG_PATTERN` are unchanged.

### Storage

Before this work, a failed update restored only the executable and configuration, so a migrated database would have left the rolled-back listener unable to start. To ship everything in one release, schema 6 adds `channel` and `chat_address` columns with `ALTER TABLE` and is applied lazily: an ordinary open stays on schema 5, and schema 6 is applied only when WhatsApp is enabled, after an update has committed. The journal reads and writes both schemas, and `chat_id` is 0 for WhatsApp rows.

- **Migration.** Add `channel TEXT NOT NULL DEFAULT 'imessage'` and `conversation_json TEXT` to `delivery_events`, and rebuild the table so `chat_id` becomes nullable (SQLite cannot drop `NOT NULL` in place).
- **Provider GUIDs.** The WhatsApp `provider_guid` is `whatsapp:<chatJid>:<messageId>`. The sender is left out because live and recovered copies of one message can report the sender in different JID forms. iMessage GUIDs remain unprefixed, so existing rows stay valid.
- **Chat keys.** iMessage keeps `chatKeyForId(chatId, salt)` so existing memory and workspaces keep their keys. WhatsApp uses `HMAC(salt, "whatsapp:" + chatJid)`. `forget` accepts either kind of chat.
- **Health.** `service_state` stores one health row per channel and one `whatsapp_watermark` (the latest processed `Timestamp`).

### Control surface for the menu bar

Every command the menu bar uses must support `--json`, exit non-zero on failure, and print a single JSON object.

| Command | Purpose |
|---|---|
| `pronto status --json` | Top-level plus per-channel health (R14) |
| `pronto channels list --json` | Channels, enabled flag, dependency version and floor |
| `pronto channels enable\|disable <channel>` | Toggle, then SIGHUP |
| `pronto tags list --json` | Each tag with its apps, e.g. `{"tag":"@s4","apps":["imessage","whatsapp"]}` |
| `pronto tags add <tag> [--app imessage] [--app whatsapp]` | In a terminal with more than one app enabled and no `--app`, it prompts with all enabled apps preselected. Non-interactive without `--app`, it applies to all enabled apps (the same default). Then SIGHUP instead of restarting launchd |
| `pronto tags set-apps <tag> --app … [--app …]` | Change which apps an existing tag applies to |
| `pronto tags remove <tag> [--app …]` | Removes the tag from the given apps, or from every app when `--app` is omitted. It refuses to leave an enabled app with no tags |
| `pronto whatsapp link --events` / `unlink` | Pairing stream for the QR sheet |
| `pronto doctor --json` | Per-channel checks (R16) |
| `pronto update --check --json` / `pronto update --json` | Update availability and install result (R17) |
| `pronto start` / `pronto stop` | Pause and resume (a `start` counterpart to the existing `stop`) |

The CLI stays the only writer of config and state. SIGHUP is delivered via `launchctl kill SIGHUP gui/<uid>/dev.pronto.agent`. On reload the daemon diffs channels: it calls `setTags` for tag-only changes and starts or stops channel watches for enable/disable changes.

### Menu bar app (`apps/menubar/`)

A native SwiftUI `MenuBarExtra` app, `Pronto.app`, built with Swift Package Manager and `xcodebuild` in the release workflow, signed with the same Team ID as `pronto`, and notarized.

```
 ● Pronto                         0.6.0
 ─────────────────────────────────────
 iMessage              ● Ready    4 min ago
 WhatsApp              ● Ready    1 h ago
 ─────────────────────────────────────
 Tags                          + Add tag
   @s4     iMessage · WhatsApp
   @help   iMessage
   @wa     WhatsApp
 ─────────────────────────────────────
 ⬆ Update available: 0.6.1   Install…
 ⚠ wacli 0.9 is below 0.10 · Copy upgrade command
 ─────────────────────────────────────
 Pause Pronto
 Run Doctor…
 Open Logs
 Settings…   (channels, link WhatsApp, launch at login)
 Quit Menu Bar
```

- **Polling.** Every 5 s while the menu is open and every 60 s otherwise, via `pronto status --json`. A cached `pronto update --check --json` runs at most every six hours, matching the updater cadence.
- **Tags.** "Add tag" opens a small sheet with a text field and one checkbox per enabled app, all checked by default. The field is validated client-side with the same pattern as `TAG_PATTERN`. Clicking a tag lets you change its apps or remove it. The CLI's error message is shown when the CLI rejects a change (for example, leaving an app with no tags).
- **Linking WhatsApp.** A sheet renders QR payloads from `pronto whatsapp link --events` with CoreImage `CIQRCodeGenerator`, refreshes when the QR rotates, and offers phone-number pairing.
- **Updates.** "Install…" runs `pronto update --json` and shows progress and the result. When the result requires a Full Disk Access re-grant, it opens the Privacy pane with the exact path. `imsg` and `wacli` upgrades are surfaced but not performed; Pronto does not manage Homebrew packages.
- **Distribution.** The menu bar app is shipped as a new per-architecture artifact in the signed update manifest, bound by size, SHA-256, signing identifier, and Team ID like the executable. `pronto update` verifies and replaces `~/Applications/Pronto.app` in the same transaction as the executable, rolls both back together on failure, and relaunches the app if it was running. `pronto setup` offers to install it. Because the app holds no privacy grants, replacing it never needs a permission re-grant.

---

## Implementation Phases

Decision (2026-09-29): Phases 1, 2a, and 2b ship together in one pull request. Phase 3's per-app `tags --app` and `--json` listing are included because every tag needs app selection; the menu bar app (Phase 4) and the remaining control surface follow separately.

Phases 1 and 3 are independent of WhatsApp and can ship first. Phase 4 can start in parallel with Phase 2 against the iMessage-only surface.

**Phase 0 — Validation spike (S).** Throwaway, and outside `main`.
1. Link `wacli` to a test account. Confirm that a phone-typed `@s4` in a direct chat and in a group arrives by webhook with `FromMe=true`, and measure the latency.
2. Confirm that a delegated `send text --reply-to --json` returns an ID while `sync --follow` holds the lock, and that its echo arrives with the same ID.
3. Confirm that `--presence-mode quiet` keeps phone notifications audible.
4. Confirm that LID-to-phone JID resolution is stable for group senders.
5. Confirm the reconnect backlog shape and that `offline_sync_completed` fires.

**Phase 0 results (2026-09-29, `wacli` 0.19.0, self-chat):**
- A phone-typed `@spike test` in "Message yourself" reached the webhook with `FromMe: true`. It arrived in the reconnect catch-up (`offline_sync_completed`, count 1) about 16 s after it was sent.
- A forwarded `send text --json --reply-to … --allow-self` succeeded in about 2.3 s while `sync --follow` held the store, and returned `data.id`. It appeared on the phone as a quoted reply, so self-chat follows the iMessage rules with no exception.
- A send issued before the follow process has opened its forwarding socket fails with `store is locked`. The module must wait for follow readiness (or pass `--lock-wait`) before its first send, and must treat a lock error as `failed`, not delivered.
- `wacli` resolved the owner's phone JID to an `@lid` JID on send, so owner and chat identity must normalize both forms.
- Pronto's own sends did not come back through the webhook. One incoming group message was posted twice with the same ID (next to an `unhandled_message_payload` warning), so deduplication by message ID is required.
- Loopback webhooks require `--webhook-allow-private`.
- Still to verify: group and one-to-one tagged replies, and `--presence-mode quiet` notification behavior.

**Phase 1 — Channel layer, iMessage only (M).** ADR 0007; `Channel` interface and `ImessageChannel`; turns, journal API, broker, and chat keys addressed by `{ channel, id }`; config v3 with migration and per-app tag helpers; per-app health rows and `status --json` channels. The updater snapshots the state database and restores it when a failed candidate migrated it past the previous schema. There is no state schema change: the journal still stores only iMessage chats, and the acceptance criterion is that existing tests and a live iMessage smoke test behave identically.

**Phase 2a — `pronto-whatsapp` module (M).** `packages/whatsapp` (supervisor, webhook listener, normalizer, recovery and checkpoint, scoped history, sender, presence, linking); module tests with a fake `wacli`; README; release workflow publication. Pre-release versions, as with `pronto-imessage`.

**Phase 2b — WhatsApp in Pronto (M).** Lazily applied state schema 6 (see Storage). `WhatsappChannel` adapter, WhatsApp reply formatter, eligibility predicate, setup and consent, `pronto whatsapp link|unlink`, doctor checks, and a WhatsApp section in `docs/LIVE_SMOKE.md`. Pronto exact-pins the released module.

**Phase 3 — Control surface (S).** `--json` on tags, channels, update, and doctor; `channels` and `start` commands; SIGHUP reload with diffing.

**Phase 4 — Menu bar app (M).** SwiftUI app, CLI client with designated-requirement verification, QR sheet, tag sheet with app checkboxes, login item, release workflow signing and notarization, the manifest artifact with updater install and rollback, and the setup offer.

---

## Test Plan

- **Unit.** Config v1/v2 → v3 migration, per-app tag invariants, and the app-selection default (`config.test.ts`, `cli.test.ts`); a shared parity table that runs the same activation cases (owner participation, tag matching, age limits) against both the iMessage and WhatsApp predicates, plus WhatsApp-only cases for R9 (`activation.test.ts`); updater install and rollback of the app artifact (`update.test.ts`); webhook signature verification and payload normalization; send disposition mapping from recorded `wacli` JSON and error fixtures; WhatsApp reply formatting; `provider_guid` namespacing and journal migration (`migrations.test.ts`); status JSON shape (`cli.test.ts`).
- **Module.** `packages/whatsapp/test` covers normalization, signature rejection, the age limits, recovery after a follow-process crash, send-outcome mapping, and the linking stream, all without Pronto.
- **Integration.** A fake `wacli` executable that serves `sync --follow` by posting signed webhooks and emitting `--events`, and records `send` / `presence` invocations. Cover: tagged message → one quoted reply; echo suppressed; follow process crash → restart without resending; `logged_out` → `needs_link`; a live webhook message older than 5 minutes suppressed while a recovered message under 24 hours is answered; iMessage keeps working while WhatsApp is failed; SIGHUP tag change applied without a restart.
- **Live smoke.** Extend `docs/LIVE_SMOKE.md` with WhatsApp direct and group checks, and a menu bar checklist: add/remove a tag, disable/enable a channel, link, pause, update.

---

## Risks

- **Account restriction.** Mitigations: an explicit disclosure; low send volume by construction (one reply per tagged message); `--send-spacing` is available if needed; no bulk or unsolicited sends; `presence-mode quiet`.
- **Linked-device expiry.** WhatsApp unlinks devices after extended phone inactivity. `needs_link` must be loud in the menu bar.
- **`wacli` churn.** Pin a minimum version, qualify capabilities at startup, and treat `wacli.db` as private; use only the CLI, the webhook, and `--json`.
- **Replying to others as the owner.** Parity means any participant in a chat where the installer has spoken can trigger a reply sent as the installer. WhatsApp groups tend to be larger than iMessage groups, so the setup disclosure must say this plainly.

---

## Open Questions

None. Remaining unknowns are covered by the Phase 0 spike.
