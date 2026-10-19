# Machine-readable CLI

The menu bar app and other local tools drive Pronto only through the installed
executable at `~/Library/Application Support/pronto/bin/pronto`. Every command
below accepts `--json`, prints exactly one JSON object (or NDJSON for streams) to
stdout, and exits non-zero on failure. Failures print `{"error": "<message>"}`.
Output never contains message text, participant identifiers, or chat keys.

App names are `imessage` and `whatsapp`.

## Status

`pronto status --json`

```json
{
  "version": "0.5.0",
  "listener": "running",
  "daemon": "ready",
  "database": "ready",
  "channels": {
    "imessage": { "state": "ready", "tags": ["@s4"] },
    "whatsapp": { "state": "needs_link", "tags": ["@s4", "@wa"] }
  },
  "degradedCapabilities": [],
  "active": 0, "ambiguous": 0, "parked": 0, "rateLimited": 0,
  "lastSettledAt": 1790719000000
}
```

`listener` is `running`, `loaded`, or `stopped`. `daemon` is `starting`, `ready`,
`degraded`, `failed`, `stopped`, or `unknown`. A channel `state` is `starting`,
`ready`, `degraded`, `failed`, `needs_link`, `stopped`, or `unknown`, with an
optional `reason`. The exit code is 0 only when the listener is running and the
daemon is ready; the JSON is printed either way.

## Apps

`pronto channels list --json`

```json
{
  "channels": [
    { "app": "imessage", "label": "iMessage", "configured": true, "enabled": true,
      "tags": ["@s4"], "tool": { "name": "imsg", "path": "/opt/homebrew/bin/imsg", "installed": true } },
    { "app": "whatsapp", "label": "WhatsApp", "configured": false, "enabled": false,
      "tags": [], "tool": { "name": "wacli", "path": null, "installed": false } }
  ]
}
```

`pronto channels enable <app> --json` and `pronto channels disable <app> --json`
print the same shape as `channels list`. Enabling an app that is not configured
fails; WhatsApp is configured by `whatsapp link`. At least one app must stay
enabled. Changes apply to the running listener without restarting it.

## Tags

`pronto tags list --json` prints:

```json
{
  "tags": [{"tag": "@s4", "apps": ["imessage", "whatsapp"],
            "agents": {"primary": "codex", "backup": "claude", "inherited": true}}],
  "availableAgents": [{"id": "codex", "label": "Codex", "available": true},
                      {"id": "claude", "label": "Claude Code", "available": true}]
}
```

`pronto tags add <tag> --app <app> [--app <app>] --json` and
`pronto tags remove <tag> [--app <app>]... --json` print the same shape. Without
`--app`, `add` applies to every enabled app and `remove` removes the tag from
every app. Every enabled app must keep at least one tag. Changes apply to the
running listener without restarting it.

`pronto tags agents <tag> --primary codex|claude --backup codex|claude|none --json`
saves a complete agent pair for one existing tag and returns the same shape.
`pronto tags agents <tag> --reset --json` removes the override and restores the
global setup defaults. The pair applies to that tag in every messaging app;
other tags and global defaults remain unchanged. The default and backup must
differ, and selected executables must be installed. `backup: null` disables
backup for that tag, even when setup has a global backup.

Existing configurations inherit the global pair. Overrides persist across
restarts, updates, and setup for tags retained by setup. Removing a tag's final
app assignment also removes its override. Choices are captured when each turn
starts; an active turn retains its original pair. Backup still runs only after
an operational failure with no tool activity. This preserves the existing
protection against repeating work with uncertain side effects.

The extra JSON fields are additive. Older menu bar versions ignore them;
newer menu bar versions can read the old shape but require an updated CLI to
edit agent choices.

## WhatsApp linking

`pronto whatsapp link --events [--phone <number>] [--accept-risk] [--tag <tag>]...`

Streams NDJSON to stdout, one object per line, and never prompts:

```json
{"event":"qr","code":"2@..."}
{"event":"pairing_code","code":"ABCD-EFGH"}
{"event":"syncing"}
{"event":"linked"}
{"event":"error","reason":"consent-required","message":"..."}
```

When WhatsApp is not configured yet, `--accept-risk` records the owner's
acceptance of the WhatsApp disclosure (the caller must show that disclosure) and
`--tag` sets its tags (default: every configured tag). Without `--accept-risk`
the stream ends with `reason: "consent-required"`. QR codes rotate; render each
new `qr` event. `syncing` means the phone accepted the link and wacli is finishing
its first sync of recent messages, which can take a few minutes; `linked` follows. The command exits 0 after `linked` once the listener has picked
up the change. Terminate the process to cancel.

`pronto whatsapp unlink --json` prints `channels list` output.

## Listener

`pronto start --json` and `pronto stop --json` print `{"listener": "running"}` or
`{"listener": "stopped"}`. `stop` drains the current turn and keeps the listener
stopped until `start`.

## Diagnostics

`pronto doctor --json` prints `{"healthy": true, "checks": [{"id": "whatsapp-linked", "status": "ok"}]}`.
A check `status` is `ok`, `degraded`, or `failed`, with an optional `remediation`.
Runtime probes can take about a minute.

## Updates

`pronto update --check --json`:

```json
{ "status": "available", "installedVersion": "0.5.0", "version": "0.5.1" }
```

`status` is `current` or `available`. When the menu bar app is installed, a
`menubar` field reports it: `{"status": "current", "installedVersion": "0.5.0"}` or
`{"status": "available", "installedVersion": "0.5.0", "version": "0.5.1"}`.

`pronto update --json` installs a verified update and prints
`{"status": "installed", "version": "0.5.1"}`; other statuses are `current`,
`migration_required`, and `migration_installed`. An installed menu bar app is
updated in the same run and reported as `menubar: {"status": "installed" | "current", "version": ...}`.
The updater quits and reopens the app when it replaces it.

## Menu bar app

`pronto menubar status --json` prints the `menubar` shape above, or
`{"status": "not_installed", "version": "0.5.1"}`. `pronto menubar install --json`
installs or updates `~/Applications/Pronto.app` from the signed release and opens
it; `pronto menubar uninstall --json` removes it.

## Slack desktop (beta candidate)

`slack discover --json` returns `{ "workspaces": [{ "handle": "<opaque>", "label": "Example", "profile": "direct" }] }`. Discovery is metadata-only. Handles expire after ten minutes and are local to this installation/link generation.

`slack link --workspace <handle> --events --accept-risk [--tag <tag>]...` emits NDJSON: `approval_required`, then `linked` with `workspace`, `member`, and `selectionRequired: true`, or `error` with `reason` and `message`. Only this explicit operation may request interactive macOS credential approval. It sends no messages and selects no conversations. `pronto setup` supports Slack-only installation. For scripted fresh configuration, linking also accepts `--accept-trust --runtime <codex|claude> --working-directory <absolute-folder>`; normal installation still uses setup. Both trust disclosures apply.

`slack conversations list --json` returns `{ "conversations": [{ "handle": "<opaque>", "label": "Example", "type": "self|dm|group|channel", "supported": true, "selected": false, "eligibility": "eligible|unknown" }], "truncated": false }`. Unsupported rows include a reason. This command reads no conversation history. A bounded participation miss remains unknown.

`slack conversations select --conversation <handle> [--conversation <handle>]... --json` atomically replaces selection with at most five unique supported conversations. `--clear` replaces it with none. Response: `{ "selected": 1 }`. New/reselected conversations start from the current cutoff; previously selected conversations retain it. No conversations are implicitly selected. Empty selection is linked but degraded (`slack-selection-required`).

`slack unlink --json` returns `{ "linked": false }`, revokes scopes and queued authority, and preserves Slack's desktop login and confirmed Pronto memory. The existing channels/tags/status/doctor/forget/start/stop commands support `slack`. Ordinary status and diagnostics omit Slack labels, provider IDs, scope tokens, credentials, and message text. Explicit onboarding returns labels; `status --chats` retains the existing opaque memory-key behavior.

Replies are text-only, from the linked member. Channel roots open a response thread; actual replies keep their root; ordinary DMs use the timeline. Thread metadata on a root does not convert a DM timeline request into a thread request. Every thread has separate memory and working-folder state. Any human participant in an explicitly selected, positively eligible conversation can invoke configured tags; tags are not authentication. No test command sends automatically.

`slack self-test --json` verifies the bundled helper without opening the Slack profile, accessing Keychain, connecting, migrating provider state, or sending. It returns `{ "helperProtocol": 1, "version": "1", "architecture": "arm64|x64", "signatureVerified": true }`. It may materialize the bundled helper in its private hash-specific directory. The daemon's private log records only aggregate Slack recovery costs and tagged-request latency (`component: "slack-monitor"`), with no workspace/member/conversation IDs, scope tokens, or message bodies.
