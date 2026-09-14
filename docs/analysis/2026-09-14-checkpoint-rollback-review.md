# Checkpoint rollback review

Standards and Spec reviewed sequentially, as required by the workspace tool map.
The owner-approved complete baseline remains `402ee7d`; the previously reviewed
changes are merged in `8965f1f`. This addendum reviews the 0.4.2 compatibility delta
against that merge. Requirements are the consumer's local checkpoint rollback
ticket 06 and Pronto's recovery, release and live-smoke contracts. No private
consumer source or state is copied into this public repository.

## Standards

No outstanding findings. Provider persistence compatibility remains inside the
Messages module, without consumer parsing or a new public interface. Node ESM
support, private atomic state writes, bounded witness retention and replacement
checks remain intact. Real released SDKs and synthetic provider processes exercise
the approved subscribe/recovery interface. Test setup formatting was clarified.

## Spec

The original regression is locked down: released SDK 0.2.0 resumes the pending row
after a current writer, and both readers repeatedly alternate without replay.
Idle upgrade from 0.4.1 and remount preserve this behavior. Existing replacement,
missing/changed witness and recovery-bound tests still fail closed as intended.
Every new legacy-to-stable rebind retains a private backup; it never overwrites the
earlier retained checkpoint or rewinds the active cursor.

Known excluded rollback target: 0.4.1 itself cannot repeatedly downgrade after
earlier migration backups differ, because that released implementation rejects the
fixed-name backup. An exploratory real-reader test demonstrated this limitation.
Upgrading from 0.4.1 is supported; use the original pre-0.4 consumer as rollback.
The compatibility contract does not claim every historical SDK is rollback-safe.

Candidate.1 passed signed CI but failed live restart after 32 untagged fillers.
The saved checkpoint advanced without replay but exceeded installer readiness.
Read-only profiling identified repeated 128-chat catalogs at 1.48–1.74 seconds per
call, compared with 173 ms for a 20-chat page containing the recent self-chat.
Stats and single-row reads were approximately 40 ms. The fix adds the provider's
default 20-chat first page to the existing bounded fallback sequence. It caches no
routing or authority and retains exact account/conversation matching. A public
subscribe regression reproduced incomplete catch-up (7/16 rows), then recovered all
16 inside the same budget. Public subscription fixtures preserve older-chat routing
beyond both the first and second catalog pages. No installer deadline was increased.

The provider's [v0.15.0 RPC contract](https://github.com/openclaw/imsg/blob/v0.15.0/docs/rpc.md#chatslist)
supports the default-sized list plus a positive limit; no undocumented selector or
new provider release is required. Review caught one additional Spec issue before
candidate.2 installation: reducing the first page for address-only resolution could
miss a duplicate match previously visible in the 128-chat page. A public regression
reproduced the incorrect reference, then passed when the fast path was restricted
to provider events with an exact chat ID. Address-only search is unchanged.
Candidate.2's build was cancelled and it is not qualified. Re-review finds no
outstanding Standards or Spec implementation issues. Candidate.3 needs fresh signed
self-chat/restart qualification; neither earlier candidate may publish.

The owner explicitly approved carrying forward the prior Christina test because
that participant is unavailable. RELEASE_QUALIFICATION.md records the one-release
0.4.2 exception, not a fresh remote test. Automated/signing and fresh self-chat,
context, memory and restart checks remain mandatory, followed by immutable
publication and the consumer's unchanged rollback regression and signed rollout.

Summary: Standards 0 outstanding findings. Spec implementation passes its local
contract; signed/live and consumer release gates remain open.
