# Security

## Trust model

The configured trigger tag is not authentication. Anyone in an eligible
iMessage conversation can ask the selected local agent to act with that
agent's effective noninteractive permissions. Conversation context may be sent
to the configured model provider. The Mac owner is responsible for informing
participants and choosing chats whose members they trust.

`s4imsg` limits its own Messages query capability to the originating chat, but
it does not sandbox Codex or Claude Code. Untagged messages and attachments are
untrusted evidence and may still influence model behavior.

The current-chat query token is random, expires, is scoped to one numeric chat
row, and is passed only through a child-process environment. It is revoked after
every runtime attempt. The MCP surface is read-only and cannot send, react, vote,
edit, unsend, or select another chat. This boundary does not restrict the
runtime's other locally configured tools.

Private state is stored below `~/Library/Application Support/s4imsg` with
owner-only permissions. The database retains at most eight confirmed tagged
request/reply exchanges and one compact summary per chat. It does not archive
ordinary messages, participant rosters, attachment metadata, attachment bytes,
tool results, or raw provider output. In-flight and ambiguous delivery records
may temporarily retain a tagged request and accepted reply so recovery can avoid
duplicate local work or sends. Use `forget` for tagged memory and the confirmed
purge form of `uninstall` for all local bridge state and logs.

Possible-side-effect runtime failures and uncertain sends are never replayed
automatically. The trigger tag and prompt labels reduce accidental activation and
prompt injection risk, but are not authorization or process isolation.

## Reporting vulnerabilities

Do not include real message text, participant identifiers, chat identifiers,
attachment paths, credentials, or provider output in a public report. Open a
minimal private security advisory in the eventual GitHub repository.
