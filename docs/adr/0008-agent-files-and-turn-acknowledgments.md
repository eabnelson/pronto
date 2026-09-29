---
status: proposed
---

# Let agents reply with one file and acknowledge turns with a reaction

An agent may return `attachmentPath`, the absolute path of one local file, with its reply. Pronto follows ADR 0004 for both apps: it refuses anything that is not a readable, non-empty regular file (no symbolic links) within the app's limit (20 MB for WhatsApp, iMessage's 100 MB), copies it into a private staging directory under the application support directory, records the staged path with the accepted reply, sends the reply text with the file, and deletes the copy once the outcome settles. A file that fails these checks is dropped and the text is sent alone. An ambiguous send is never repeated. `pronto-whatsapp` gains the same narrow capability as the Messages module: `reply` accepts one consumer-staged `filePath`.

The staged path is stored in `service_state` under a per-event key instead of a new `delivery_events` column. Both the iMessage-only schema 5 and the multi-app schema 6 already have that table, so the change needs no migration and a rolled-back executable can still open the database; it simply sends the text of a pending reply without the file.

When a turn's runtime starts on a WhatsApp message, Pronto reacts to that message with 👀. It is best-effort and never delays or fails the turn, and `channels.whatsapp.acknowledge: false` turns it off. This is the only reaction `pronto-whatsapp` exposes. The Messages module has no reaction capability yet, so iMessage turns are not acknowledged; the channel's optional `acknowledge` method is where it would attach.

## Consequences

Any participant who can trigger a turn can ask the agent to send a file it can read. This adds no access the unrestricted agent lacked (it could already paste file contents into a text reply), but it makes sending documents easy, so the setup trust disclosure states it explicitly.

WhatsApp media that has expired off WhatsApp's servers fails with a typed `attachment-expired` error that the agent sees. Recovering it needs `wacli media retry`, which asks the phone to upload the media again but requires the store lock that the running `sync --follow` holds, has no delegated form, and cannot target a single message. Pronto therefore does not try it.
