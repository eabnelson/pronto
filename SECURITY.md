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

## Reporting vulnerabilities

Do not include real message text, participant identifiers, chat identifiers,
attachment paths, credentials, or provider output in a public report. Open a
minimal private security advisory in the eventual GitHub repository.
