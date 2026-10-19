# Slack beta qualification

The implementation is a candidate for supervised testing. Production release is blocked by the pending entries in `docs/slack-qualification.json`. Offline fixtures and successful compilation do not qualify a Slack account or prove sleep behavior.

Run offline checks with `bun run typecheck`, `bun test`, `bun run build`, `swift test --package-path apps/menubar`, and `go test ./...` inside `packages/slack/native`. Import `packages/slack/dist/index.js` from Node and Bun. Candidate builds do not connect to Slack. `slackHelperPath` verifies embedded bytes, code signature, architecture, version, and private RPC protocol using a credential-free self-test. Helpers are embedded in the existing signed executable artifact, preserving the updater's exact manifest and asset contract. Executable rollback therefore restores its corresponding helper. Extraction uses a hash-specific private path and never replaces a previous helper in place.

Initialize private qualification evidence with:

```
bun scripts/slack-qualification.ts --init .scratch/slack-channel/qualification.json v0.4.3
```

Record the exact signed artifact SHA-256 for both architectures, device/profile versions, test identities using local opaque aliases, and evidence for each gate. Keep account IDs, message bodies, private links, and screenshots in `.scratch/`. The validator checks a record; the person conducting qualification must verify the underlying evidence. It cannot infer that a checked box is true.

The supervised test pass starts with an owner-selected self DM in the explicitly chosen workspace. Install the candidate deliberately, discover the workspace, accept the workspace coverage disclosure and approve Keychain access if requested. In the workspace app flow, add that workspace and verify eligibility in the test DM. Connection and doctor never send messages automatically. Publish a clearly labeled tagged request manually; verify the local runtime and one correctly routed owner-authored response. Check memory/folder continuity, thread separation, pause/resume, forget, unlink/relink, and an ambiguous-send fault without duplicate delivery. Broader tests use agreed test conversations in the added workspace and any needed participant authorization.

For credential gates, use a fresh signed installation, then prove unattended background startup cannot prompt. Cover Slack open/closed/updated, session revocation, member changes, denied Keychain approval, and both advertised CPU architectures. Re-approval after a helper/signature change must happen through explicit linking. An ad-hoc local build does not establish Developer ID Keychain ACL continuity.

For monitoring, use five permitted conversations in the added workspace, run at least 30 minutes, and independently publish at least 20 requests across the supported types and old previously unseen threads. Measure publication-to-admission p95 below ten seconds with clock skew under one second, zero missed eligible requests, and actual method/byte/page costs. Include messages read on another device, cap exhaustion, 429s, network loss, helper death, and listener restart.

For sleep, record native will-sleep/wake evidence and an actual sleep of at least two hours. Publish requests independently while the Mac is asleep. Verify bounded recovery and no duplicates after wake. The earlier prototype's short sleep and pre-sleep queued message do not satisfy this gate. A Mac reboot is unnecessary.

After completing private evidence, copy a redacted pass/fail matrix and exact candidate hashes into the tracked record. Check it with `bun scripts/slack-qualification.ts --check docs/slack-qualification.json <exact-tag>`. Publishing is separately authorized; the release workflow refuses to publish while required Slack gates are pending or failed. Signed candidate-only builds remain available for qualification.

Workspace app qualification additionally covers two independent workspace connections, per-workspace tags and enable/disable, removal and relinking without affecting the other workspace, and cross-workspace scope rejection. Workspace coverage must prove positive owner participation in timeline and thread history, ignore pre-connection requests, discover new conversations, reject unsupported destinations, retain revocation rules, and remain bounded and visibly degraded at discovery/recovery limits. Offline fixtures cover these mechanics; supervised multi-workspace, signed-helper, and sleep evidence remains required.
