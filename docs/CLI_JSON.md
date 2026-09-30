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

`pronto tags list --json` prints `{"tags": [{"tag": "@s4", "apps": ["imessage", "whatsapp"]}]}`.

`pronto tags add <tag> --app <app> [--app <app>] --json` and
`pronto tags remove <tag> [--app <app>]... --json` print the same shape. Without
`--app`, `add` applies to every enabled app and `remove` removes the tag from
every app. Every enabled app must keep at least one tag. Changes apply to the
running listener without restarting it.

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
