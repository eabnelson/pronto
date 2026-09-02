---
status: accepted
---

# Rename s4imsg to Pronto before the first public release

The repository, product, package metadata, primary command, documentation, release assets, and new-install paths use Pronto before the first qualified public release. The existing repository has no release tags and its qualification matrix still blocks publication, so carrying the temporary name into a public compatibility contract would create cost without protecting a released audience.

## Consequences

Setup detects an existing `s4imsg` installation, stops its LaunchAgent, backs up and migrates retained configuration and SQLite state, installs exactly one Pronto listener, and requalifies the executable under macOS privacy controls before removing the legacy service. Compatibility-sensitive persisted schema and sealed-token namespace strings may keep their legacy values. A temporary `s4imsg` command shim explains the rename and delegates safe commands, but new documentation and releases use `pronto`.
