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
every app. iMessage and WhatsApp must keep at least one tag. Slack workspaces
can have no tags while waiting for assignment from the Tags section; they
accept no tagged requests in that state. Changes apply to the
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

## Slack workspaces (beta candidate)

Each connected Slack workspace is a separate app in `channels list`, with its
own label, tags, enabled state, and health. The original connection keeps the
app ID `slack` and its existing memory. Additional workspace IDs use
`slack:<32 lowercase hexadecimal characters>`. These are opaque identities,
not Slack provider IDs. `channels enable/disable <app>` and
`tags add/remove --app <app>` accept these IDs, including tag edits while a
workspace is off.

`slack discover --json` returns `workspaceApps: true`, `deferredTags: true` and workspace choices
with `handle`, `id` (opaque workspace key), `label`, `profile`, and `connected`.
Handles expire after ten minutes. Discovery sends no messages and does not
choose a workspace. The add picker excludes already-added workspaces.

`slack link --workspace <handle> --events --accept-risk [--defer-tags | --tag <tag>...]` adds
the chosen workspace without replacing another connection. It streams
`approval_required`, then `linked` with `workspace`, `member`, `app`, and
`selectionRequired: false`, or an `error` event with a safe reason and message.
macOS credential approval occurs only during this explicit operation.
Workspace tags apply in supported conversations where positive owner
participation has been observed. Connecting sends no message; requests before
the connection cutoff cannot activate.

The menu bar uses `--defer-tags`: a new workspace starts with no tags, and
reconnecting preserves its latest existing tag assignments. Tag creation and
assignment happen only under Tags in the menu bar. `--defer-tags` cannot be
combined with `--tag`. Without either flag, existing tags are preserved and a
new connection defaults to `@pronto` for CLI compatibility.

Existing manually selected connections retain their policy until explicitly
reconnected or migrated with
`slack scope --all-participated [--app <app>] --json`. This returns `app` and
`coverage: participated`. The menu bar has no conversation-selection step.
Advanced consumers can still use
`slack conversations list [--app <app>] --json` and
`slack conversations select (--conversation <handle>... | --clear) [--app <app>] --json`
to opt into the original selection policy.

`slack unlink [--app <app>] --json` removes that workspace's app and tag
assignments and returns `linked: false`. It revokes only that workspace's
scopes, preserves other workspaces and their settings, and leaves Slack's
desktop sign-in unchanged. At least one enabled app must remain. Turning a
workspace off preserves catch-up state. Removing a tag's final app assignment
also removes its per-tag agent override.

Workspace discovery is bounded to 500 conversations and 20 metadata pages per
refresh. Recovery retains completed conversation checks across bounded batches
and resumes large histories from page checkpoints. Its optional
`progress: { checked, total }` reports coverage counts. Initial catch-up remains
degraded until all conversations are checked; later batches retain healthy
coverage for at most one hour after a successful conversation check completes. Actual read/admission failures invalidate that
coverage immediately. Restart, wake, and connection loss require fresh checks.
Progressing batches with unfinished work continue automatically after one second;
completed sweeps, failures and batches without progress wait sixty seconds.
Missing participation evidence never grants permission. Slack Connect, externally shared, archived, and
read-only conversations remain unsupported. Reconnecting rotates authority;
workspace, member, conversation, and thread isolation remain enforced.

Replies are text-only and come from the connected member. Channel roots open
a response thread; actual replies retain their root; ordinary DMs use the
timeline. Each thread has separate memory and a working folder. Any human
participant in an eligible conversation can invoke the workspace's tags.
No test command sends automatically.

`slack self-test --json` verifies the bundled helper without opening the Slack
profile, accessing Keychain, connecting, migrating provider state, or sending.
It returns `helperProtocol`, `version`, `architecture`, and `signatureVerified`.
Private monitor logs contain only recovery costs and latency, never credentials,
provider IDs, scope tokens, or message bodies. Added workspace app IDs require
a CLI supporting workspace apps; older executables cannot load those entries.
