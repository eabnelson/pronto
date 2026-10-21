# Provenance

`pronto` is implemented clean-room from public command and protocol contracts.
No Studio Four source code is copied into this repository.

Public implementation references:

- `openclaw/imsg` README, JSON schema, and JSON-RPC documentation
- Anthropic's public Claude Code CLI documentation
- OpenAI's public Codex repository and CLI documentation

Studio Four was used only to identify product behavior worth preserving. Its
files, implementation details, fixtures, and tests are not inputs to this
repository's source history.

The consumer routing contract added for `pronto-imessage` 0.2.0 was derived
from consumer-neutral behavior: exact account-and-conversation resolution,
bounded scoped access, provider delivery classification, and submission of one
consumer-staged outbound file. It was independently implemented in this public
repository and verified with synthetic public transcript and fault fixtures.
No private consumer imports, source history, fixtures, identifiers, or domain
models were used.

The versioned checkpoint-adoption seam added for `pronto-imessage` 0.2.1 was
cleanly derived from the predecessor consumer's generation-bound cursor format.
Only the generic database identity canonicalization was retained. Adoption
requires the caller's pre-cutover provider-message witness and is covered by
public replacement/rebuild rejection tests; no consumer code or private history
was copied.

The Slack desktop helper adapts the public MIT-licensed sttts/slagent LevelDB reader at commit `4b959bdf2a8207daeb597ed8f2ed360b2c7f51a9`, with its license retained. Credential decryption, the bounded private RPC, transport, native power integration, selection, scopes, and recovery were implemented here from public contracts and authorized local experiments. Committed tests use synthetic accounts and messages. Private prototype results and planning remain ignored under `.scratch/`.
