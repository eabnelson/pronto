---
status: accepted
---

# Bind a chat to one local linked Git worktree

Pronto may persistently bind an opaque Messages chat key to one existing linked
Git worktree and one configured local runtime. The owner creates the binding
locally with `pronto worktree bind <chat-key> <path> --agent <codex|claude>`.
Ordinary tagged turns for that chat then run the selected agent in the bound
worktree. A configured Conductor Cloud tag remains an explicit, separate route.

Pronto accepts only a canonical directory whose `.git` file points to live
linked-worktree metadata. It validates the binding before every turn. A bound
turn cannot change folders, offer workspace candidates, or fall back to a
different runtime. The owner can inspect or remove bindings with `pronto
worktree list`, `pronto worktree unbind`, or `pronto forget`.

## Consequences

The feature works with Conductor's local worktrees without depending on a
Conductor API key, private app state, or unsupported desktop automation. Code
and Git changes made by the Pronto-launched agent appear in Conductor because
both tools use the same worktree. The existing Conductor desktop conversation
is not resumed; Pronto starts a separate one-shot Codex or Claude process.

The linked worktree remains organizational context rather than a sandbox. The
selected runtime has the same unrestricted local authority as every other
Pronto turn. Users must avoid concurrent agents editing the same worktree and
must rebind after Conductor archives, removes, or replaces it.
