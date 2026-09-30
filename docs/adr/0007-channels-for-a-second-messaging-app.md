---
status: proposed
---

# Add a second messaging app through channels and a second module

WhatsApp becomes a second messaging app. ADR 0001 declined a speculative provider-neutral framework while Apple Messages was the only provider. With a real second provider, Pronto adds two things and nothing more general.

First, the standalone product gains a `Channel` interface in `packages/cli`. A channel qualifies and watches one app, applies that app's activation rules, formats replies, reads bounded current-chat context, and sends into the originating conversation. Turns, the delivery journal, memory, workspaces, and the current-chat broker address a conversation as `{ channel, id }` instead of a numeric Messages chat id. Configuration keeps per-app sections with their own tags. iMessage chat keys, echo fingerprints, and stored conversation references keep their existing encodings, so upgrades keep existing memory and workspaces. The iMessage adapter wraps the existing transport without behavior changes.

Second, WhatsApp mechanics ship as a separate published module, `pronto-whatsapp`, following the ADR 0001 contract: provider mechanics inside, consumer policy (tags, activation, journal, product state) outside. Its defaults match the Messages module's live and recovery age limits and scope lifetime, so a consumer gets identical activation rules. The two modules share no runtime code.

Earlier updaters restore only the executable and configuration on a failed update, so a schema migration during an update could leave a rolled-back listener unable to open its database. The updater now snapshots the state database first and restores it when a failed candidate migrated it past the previous executable's schema. The schema that stores non-iMessage chats is also applied lazily: an ordinary open stays on the iMessage-only schema, and the multi-app schema is applied only when WhatsApp is enabled, which happens after an update has committed. The delivery journal reads and writes both schemas, so WhatsApp can ship in the same release as the updater fix.
