---
status: proposed
---

# Position history within an observed conversation

Add an optional `afterRowId` to bounded forward history, usable only with a current conversation reference and without a continuation. A durable consumer can re-observe its exact account and conversation, then read one known row without scanning unrelated history; existing reference, generation, expiry and cumulative-budget checks still apply.

The consumer must retain and compare the original generation, account, conversation, row, message identity and content digest before execution, then obtain current product authority. A row position is a search bound, not an authorization capability or proof that a message is unchanged. Consumers negotiate `positioned-history` in module qualification before depending on it, since older modules would ignore an unknown option.

The restart experiment is preserved on `erik/prototype/message-replay` at `3faa60c`. It restored the unchanged synthetic message and distinguished edited/deleted/replaced messages, account changes and database replacement without persisting message bodies. Queue expiry was modeled, not a real-time durability test; production tests must verify it. This keeps raw RPC internal and avoids a second kind of sealed message capability.
