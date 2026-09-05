# Release qualification

Public release requires every automated gate and an owner-run live smoke. This
file records capability evidence, not private conversation data.

The matrix below is historical v0.3.0 evidence. The v0.4.0 candidate.1 passed
fresh self/remote replies, self-chat recent context, tagged memory beyond 32
untagged messages and an idle restart on 2026-09-04. Active-turn replacement
failed: launchd interrupted the synthetic turn before drain. The installer
refused replacement and restored the listener; the uncertain synthetic turn
remains parked without replay. Candidate.1 must not be promoted. A new candidate
with bounded shutdown qualification is required; public v0.4.0 remains blocked.
Never carry v0.3.0 remote evidence across v0.4.0's message-transport changes.

Candidate.1 source: `e694dcb15b2342b3b88b344912eb98abb59dcba1`, protected CI run
`33931479985`; arm64 SHA-256
`1d1590881a567bbd4f0b2b5711da011deaba7fb9c38f4de1ae4c85543b37814a`.
Both architectures passed checksum and Developer ID designated-requirement
verification. CI required notarization submit and log status Accepted. The
installed launchd candidate retained Full Disk Access and passed doctor, with
Codex 0.153.0 and imsg 0.14.1 (both CLI version and qualified protocol response).
The historical matrix's imsg 0.15.0 is not this candidate's live provider version.
No automated follow-up messages were sent to the remote chat; the owner directed
context, memory and updater tests to self-chat only.

Candidate.2 source: `a4991b1a21af2eae4961fcb6fde0896401ca4bb6`, protected CI run
`33934137599`; arm64 SHA-256
`fe78274ffe9786ed910764849d1677ca7125553ec7b77d51d2107e599ea8f0d2`.
Checksums, both Developer ID requirements, notarization, packed Node/Bun imports
and installed doctor passed. Active-turn signed replacement completed with one
confirmed synthetic reply and returned to ready; the previous uncertain event
remained parked without replay. Fresh self-chat recent context and tagged memory
save also passed, with one confirmed send each. No automated remote messages
were sent.

After 32 new untagged self-chat messages and an idle restart, the new recall
request was visible in Messages but absent from the journal. The log reported
duration-limit while status falsely reported ready. Candidate.2 is therefore
also disqualified. Local regressions cover readiness before subscription,
persisted recovery degradation, and checkpoint retry after a catch-up deadline.
Those runtime changes require another immutable signed candidate and fresh
qualification. Public v0.4.0 remains blocked; the matrix below remains historical.

## Current matrix

| Surface | Qualified version | Evidence | Status |
| --- | --- | --- | --- |
| macOS | 26.5.1 (25F80) | Local build and synthetic suite | Pass |
| Bun | 1.3.14 | Frozen install, typecheck, tests, compiled build | Pass |
| Node.js | 22.23.1 | Clean packed `pronto-imessage` import and public-interface smoke | Pass |
| imsg | 0.15.0 | Exact signed upstream artifact qualified against protocol v1; provider code unchanged since the 0.2.4 qualification | Pass |
| Codex CLI | 0.153.0 | Auth/help inspection and adapter fixtures | Pass |
| Claude Code | 2.1.260 | Auth/help inspection and adapter fixtures | Pass |
| Codex effective local probe | 0.153.0 | Setup noninteractive file-tool probe | Pass |
| Claude effective local probe | 2.1.226 | Setup noninteractive file-tool probe | Pass |
| Messages Automation | v0.3.0 signed candidate | Developer ID candidate installed after the one-time FDA migration; owner-authorized self and remote sends each produced exactly one reply on 2026-09-04 | Pass |
| Self-chat mirror handling | v0.3.0 signed candidate | One tagged self-chat activation produced exactly one agent send with no echo turn after one minute on 2026-09-04 | Pass |
| Full remote tagged flow | v0.3.0 | One remote participant's tagged request produced exactly one reply; a same-identity signed-to-signed replacement preserved FDA and returned the listener to ready on 2026-09-04 | Pass |

The automated matrix and owner smoke record versions tested on 2026-09-04.
Capability checks, not version
strings alone, determine whether setup and startup proceed.

## Automated release gates

- `bun install --frozen-lockfile`
- `bun run typecheck`
- `bun test`
- `bun run build`
- `bun run release:validate`
- Packed `pronto-imessage` imports successfully under Node.js 22.23.1 and Bun 1.3.14
- Compiled `pronto` version/help and strict macOS signature smoke checks
- Clean-room provenance and third-party notices present
- `pronto-imessage` is packed, checksummed, attached to the immutable GitHub
  release, and published to npm with provenance only after this matrix passes
- No dependency or import from Studio Four packages
- No model override or inherited interactive permission mode in adapters
- Exact unrestricted no-prompt flag present in each runtime adapter and required
  by setup qualification
- Synthetic duplicate, fallback, recovery, queue, privacy, and ambiguous-send
  cases pass against an on-disk SQLite database
- Static ownership checks reject any standalone provider RPC client, parser, probe,
  raw watch/catch-up methods, or direct provider-history implementation outside
  `pronto-imessage`

## Owner-only gate

Run `docs/LIVE_SMOKE.md` after installing the exact release candidate. Normally,
mark the remote row Pass only after a remote participant's exactly-one reply,
recent context, tagged continuity, restart suppression, and content-free logs are
observed. When the checklist's narrowly scoped carry-forward exception applies,
record the prior remote release, fresh exact-candidate self-chat evidence, and the
reviewed unchanged surfaces in the matrix. Do not publish a GitHub release while
any cell is Pending or Blocked.
