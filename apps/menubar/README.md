# Pronto menu bar app

A native SwiftUI menu bar app (`Pronto.app`, bundle id `dev.pronto.menubar`) for
checking and controlling the local Pronto listener: app status, tags, pause and
resume, updates, diagnostics, and WhatsApp linking.

The app talks to Pronto **only** through the machine-readable CLI contract in
[`docs/CLI_JSON.md`](../../docs/CLI_JSON.md). It runs the installed executable
`~/Library/Application Support/pronto/bin/pronto` with `--json` argument arrays
(never a shell), decodes the output with `Codable`, and never reads Pronto's
config or database.

## Build and test

Requires Swift 6 / Xcode 16 or later; the app runs on macOS 14 or later.

```sh
cd apps/menubar
swift build
swift test
```

## Bundle

```sh
apps/menubar/scripts/bundle.sh <outdir> [--sign-identity <identity>] [--universal]
```

Builds a release binary and writes `<outdir>/Pronto.app` with `LSUIElement`,
minimum macOS 14, and the version from the repository's root `package.json`
(`BUILD_NUMBER` overrides `CFBundleVersion`). It signs ad hoc (`--sign -`) with
the hardened runtime by default; pass a Developer ID identity with
`--sign-identity` or `SIGN_IDENTITY`. Notarization happens in the release workflow.

## Run against a development CLI

`PRONTO_MENUBAR_CLI` points the app at another executable instead of the
installed CLI and **skips code signature verification**. Use it for development
and tests only.

```sh
# From apps/menubar, with the fake CLI that serves the fixtures:
PRONTO_MENUBAR_CLI="$PWD/Tests/Fixtures/fake-pronto" swift run ProntoMenuBar

# Or the bundled app:
open --env PRONTO_MENUBAR_CLI="$PWD/Tests/Fixtures/fake-pronto" /path/to/Pronto.app
```

The fake CLI (`Tests/Fixtures/fake-pronto`) prints the fixture JSON in
`Tests/Fixtures/json` for each subcommand and streams NDJSON for
`whatsapp link --events`. It keeps pause/link state in `FAKE_PRONTO_STATE_DIR`,
chooses a status with `FAKE_PRONTO_SCENARIO` (`docs`, `healthy`, `degraded`,
`failed`), and waits `FAKE_PRONTO_DELAY` seconds (default 2) between link events.

`PRONTO_MENUBAR_SNAPSHOT=/tmp/pronto` renders the panel, diagnostics, and link
windows offscreen in light and dark mode to `/tmp/pronto-*.png`, then quits.
Use it to check layout without clicking through the UI.

Without an override, the app verifies the installed CLI before every launch
(cached until the file changes) against this designated requirement:

```
identifier "dev.pronto.cli" and anchor apple generic and certificate leaf[subject.OU] = "9YCNUWK84C"
```

A missing CLI shows "Pronto isn't installed" with a link to the
[setup guide](https://studiofour.io/imessage-setup.md). A CLI that fails
verification is never run.

## Architecture

```
Sources/ProntoMenuBarKit/   testable logic, no SwiftUI
  Models.swift              Codable types for every documented response
  CLICommand.swift          every invocation → exact argument array + timeout
  CLIClient.swift           CLIClient protocol, CLIOutput decoding rules, CLIError
  ProcessCLIClient.swift    real client: Process, background queues, timeouts, cancellation
  CLILocation.swift         installed path, PRONTO_MENUBAR_CLI override, signature check
  FakeCLIClient.swift       fake client for tests and previews
  LinkEvents.swift          NDJSON line buffer + link event parsing
  Health.swift              overall health aggregation → menu bar icon
  ChannelRows.swift         per-app status text, dot color, toggle and link rules
  Tags.swift, Validation.swift  tag rules (^@?[A-Za-z0-9_-]{1,32}$) and edit planning
  PollPolicy.swift          5 s / 60 s polling, 6 h update checks, single-flight
  MenuBarModel.swift        @Observable state and actions for the panel
  DiagnosticsModel.swift    doctor run state
  LinkModel.swift           WhatsApp link flow state machine
  QRCodeRenderer.swift      CIQRCodeGenerator, integer nearest-neighbor scaling
Sources/ProntoMenuBar/      thin SwiftUI layer (MenuBarExtra, windows, AppKit glue)
Tests/ProntoMenuBarKitTests Swift Testing suites; fixtures match docs/CLI_JSON.md
Tests/Fixtures/             JSON/NDJSON fixtures and the fake-pronto script
```

| Feature | CLI command |
| --- | --- |
| Status, icon, app rows | `status --json` (5 s while the panel is open, 60 s otherwise), `channels list --json` |
| Enable or disable an app | `channels enable <app> --json`, `channels disable <app> --json` |
| Tags | `tags list --json`, `tags add <tag> --app … --json`, `tags remove <tag> [--app …] --json` |
| Pause and resume | `stop --json`, `start --json` |
| Updates | `update --check --json` (at most every 6 h, or on demand), `update --json` |
| Diagnostics | `doctor --json` |
| Link WhatsApp | `whatsapp link --events --accept-risk [--phone …] [--tag …]` |

Menu bar icon: normal when the listener is running and every enabled app is
ready; attention (orange) when something is degraded or starting, or an update
is available; error (red) when the listener stopped after a failure, the daemon
failed, or an enabled app failed or needs linking; dimmed when paused
(`listener: stopped` without a failure).

Quitting the menu bar app never stops the listener. Launch at Login uses
`SMAppService.mainApp`, so it only works from the bundled app.
