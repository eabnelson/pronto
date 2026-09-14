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

Open gates: exact-candidate signed CI and fresh owner-authorized self/participant
qualification; then immutable publication and the consumer's original unchanged
rollback regression, complete suite and signed rollout. Local passing tests do not
qualify those gates. Historical 0.4.1 live evidence is not reused for 0.4.2.

Summary: Standards 0 outstanding findings. Spec implementation passes its local
contract; signed/live and consumer release gates remain open.
