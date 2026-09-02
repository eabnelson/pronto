---
status: accepted
---

# Allow one consumer-staged outbound file

The public Messages module may submit one absolute local file path with a reply
to an exact module-issued conversation reference. The consumer owns permission
to use the file, stages it outside provider-controlled storage, and removes it
after the delivery outcome settles. Pronto owns exact provider routing and
classifies the send as confirmed, ambiguous, or failed using the same rules as
text replies.

## Consequences

The package rejects relative paths and does not expose inbound attachment paths
or arbitrary Messages search. This decision does not add multiple attachments,
reactions, edits, unsend, typing indicators, effects, group administration, or
other rich Messages mutations. Each such capability still requires its own
reviewed product decision.

An ambiguous result means the provider may have accepted the submission and a
consumer must not replay it automatically. Authorization, file validation,
staging, retention, cleanup, and user-facing audit remain consumer policy;
Pronto accepts only the already-authorized, staged absolute path at its narrow
provider boundary.
