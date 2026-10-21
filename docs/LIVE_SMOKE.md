# Release smoke

Run this short check for the installed signed candidate. Use an owner-approved
test conversation; the tagged request invokes a real agent and sends a real reply.
CI never sends messages. Do not repeat unchanged feature tests for each release.

1. **Installed startup:** confirm `pronto status` reports the listener running and
   the configured apps healthy. Confirm the menu agrees. Check that installation
   preserved settings and background startup requires no unexpected prompt.
2. **Changed app flow:** in each app whose behavior changed, send one tagged
   request and confirm exactly one reply reaches the intended conversation/thread.
   Check the changed feature if relevant. Owner daily use on the candidate can
   supply this evidence; record what was observed. Reuse earlier evidence only
   for reviewed unchanged runtime/build inputs and name its candidate/source.
3. **Rollback readiness:** retain the previous signed executable/helper, compatible
   menu app, configuration and any state backup required by a schema change.
   Confirm how to restore them without replaying ambiguous work. Exercise actual
   rollback when update, migration or rollback code changes; otherwise the retained
   build and passing automated rollback tests are sufficient.

Record these three results against the intended release tag in the Current matrix
of [RELEASE_QUALIFICATION.md](RELEASE_QUALIFICATION.md). Name the tested
candidate/source, signed build and any carry-forward evidence. Leave unknown
results pending. Publishing still requires the owner's authorization.

For Slack, also record the four entries in [SLACK_QUALIFICATION.md](SLACK_QUALIFICATION.md);
the same startup/reply evidence can satisfy both records. Slack recovery remains
best effort, not an arbitrary-history or exhaustive catch-up guarantee.

Deeper manual testing is driven by the diff or a reported bug. Examples include
fresh permissions after signing/setup changes, attachments after media changes,
working-folder isolation after routing changes, or wake/restart after recovery
changes. Timed soak tests, a second participant, multiple workspaces, account
revocation and long sleep are not routine release requirements.

Keep private contents, identities, credentials and screenshots in gitignored
`.scratch/`; record only redacted evidence in the release documents.
