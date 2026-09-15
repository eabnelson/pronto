---
status: accepted
---

# Route one optional tag to Conductor Cloud

Pronto may configure one dedicated activation tag whose turns are sent directly
to the Conductor HTTP API instead of a local Codex or Claude Code process.
Pronto creates or recovers one Conductor cloud workspace per opaque chat key
and routing configuration, reuses its first active session, submits each tagged
request with a deterministic message ID, polls the transcript and session
status, and returns the final agent reply to the exact triggering Messages
conversation.

Local agent tags remain the default. Conductor configuration requires separate
acceptance because bounded conversation material and the authorized request
leave the Mac and Conductor stores cloud session inputs and outputs. The API key
is retained only in Pronto's owner-private configuration and is never printed by
status commands.

## Consequences

The integration depends only on Conductor's documented beta `/v0` HTTP API, not
Conductor desktop internals or local session files. It can therefore target
cloud workspaces driven by Codex, Claude, Cursor Agent, or an ACP harness while
the Pronto listener continues to run on the Messages Mac.

Conductor workspaces are intentionally not created with the first prompt.
Pronto first records the returned workspace and session identifiers, then sends
the task with a deterministic message ID. A deterministic opaque workspace name
includes the project and agent routing settings, allowing recovery after an
uncertain create response without reusing a workspace configured for a
different agent or model. If remote submission or polling becomes uncertain,
Pronto reports unknown tool activity so the delivery journal parks the turn and
never falls back to a second coding runtime.

`pronto forget` removes only Pronto's local chat-to-workspace binding. It does
not archive or delete remote code or transcript state. Automatic remote cleanup
would require a separate explicit product decision.
