# Security

## Supported versions

Until the first stable release, security fixes are made on the latest `main`
branch and included in the next tagged release. Older commits are not supported.

## Trust model

The configured trigger tags are not authentication. Any current or future participant in an eligible
iMessage conversation can ask the selected local agent to act. Claude Code runs
with `--dangerously-skip-permissions`; Codex runs with
`--dangerously-bypass-approvals-and-sandbox`. Their approval and sandbox checks
therefore do not constrain the turn. Conversation context may be sent
to the configured model provider. The Mac owner is responsible for informing
participants and choosing chats whose members they trust.

`pronto` limits its own Messages query capability to the originating chat, but
the runtime may access any command or file available to the macOS user. The
per-chat working folder is organizational context, not a security boundary.
Project instructions, hooks, plugins, and MCP servers in a selected repository
may run with the same unrestricted authority, so an untrusted repository is an
untrusted code-execution source. Untagged messages and attachments are
untrusted evidence and may still influence model behavior.

The current-chat query token is random, expires, and is scoped to one numeric
chat row. Claude Code receives it through a private temporary MCP configuration;
Codex receives it through a private temporary profile used to configure the
`pronto` MCP server. It is not added to the agent process environment or
command-line arguments, and the temporary configuration is deleted after every
runtime attempt. Because the runtime still acts as the same macOS user, this is
capability scoping rather than an operating-system sandbox. The MCP surface is
read-only and cannot send, react, vote, edit, unsend, or select another chat.
This boundary does not restrict the runtime's other locally configured tools.

Private state is stored below `~/Library/Application Support/pronto` with
owner-only permissions. The database retains at most eight confirmed tagged
request/reply exchanges and one compact summary per chat. It does not archive
ordinary messages, participant rosters, attachment metadata, attachment bytes,
tool results, or raw provider output. In-flight and ambiguous delivery records
may temporarily retain a tagged request and accepted reply so recovery can avoid
duplicate local work or sends. Use `forget` for tagged memory and the confirmed
purge form of `uninstall` for all local bridge state and logs.

Possible-side-effect runtime failures and uncertain sends are never replayed
automatically. Trigger tags and prompt labels reduce accidental activation and
prompt injection risk, but are not authorization or process isolation.

## Reporting vulnerabilities

Do not include real message text, participant identifiers, chat identifiers,
attachment paths, credentials, or provider output in a public report. Open a
minimal [private GitHub security advisory](https://github.com/eabnelson/pronto/security/advisories/new).
Include the affected version or commit, impact, and synthetic reproduction steps.
You should receive an initial response within seven days. Please do not open a
public issue until a fix and disclosure plan have been agreed.
