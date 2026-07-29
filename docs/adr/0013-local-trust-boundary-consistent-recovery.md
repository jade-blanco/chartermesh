# ADR 0013: Local trust boundary and consistent recovery

- Status: accepted
- Date: 2026-07-29

## Context

The command-process adapter removed vendor coupling but trusted whatever bytes
occupied an approved absolute path and used the target project as cwd. Control
Plane backup covered SQLite without the content-addressed artifacts referenced
by that database. Restore could ask other processes to stop but could not
enforce a write boundary for processes that already held a database
connection. HTTP model responses and audit payload projection also needed
positive bounds.

These controls must remain local, dependency-free, offline-testable, and
disabled from making paid provider calls. They must not imply an
operating-system sandbox, hosted backup, or automatic cancellation policy.

## Decision

### Approved local executable

Command-process configuration requires a lowercase SHA-256 digest. The CLI
computes it while generating the exact engine plan. The adapter verifies it
when constructed, immediately before spawn, and after process exit. A changed
executable fails closed and requires a newly approved configuration plan.

The process cwd is `.chartermesh/engine-work/ENGINE_ID`, which bootstrap ignores
in Git. `shell: false`, the minimal environment, timeout, and combined output
limit remain in force. Hash pinning and a dedicated cwd are not an OS sandbox;
the configured executable and explicit arguments remain trusted local code.

### Consistent local backup set

A snapshot transaction serializes SQLite and reads the distinct artifact
references. Every referenced artifact is verified by byte length and SHA-256
and stored once under `backups/blobs/SHA256.txt`. The manifest records the
ordered artifact set and a hash of that set. Older DB-only manifests remain
readable as empty artifact sets.

Restore binds the DB hash, current DB hash, artifact count, and artifact-set
hash into its human-approved plan. It restores the DB and required artifact
blobs through one crash-recoverable file transaction, validates both classes
afterward, and leaves unrelated project files untouched. Unreferenced
content-addressed files may remain as harmless local orphans.

### Maintenance and operator pause

Restore acquires an atomic `.chartermesh/.maintenance-lock`. New database opens
and write transactions on already-open `ControlPlane` services reject with
`CONTROL_PLANE_MAINTENANCE_ACTIVE`. A live owner prevents lock stealing; a
dead, older lock is recoverable.

An independent, human-only pause flag is off by default. When explicitly
enabled it blocks new claims with `OPERATIONS_PAUSED`; it does not cancel an
active run or mutate WorkItem state.

### Positive network and export bounds

The OpenAI-compatible adapter sets `redirect: error` and reads response bodies
through a configurable byte ceiling: 8 MiB by default, 1 KiB minimum, and
64 MiB maximum.

Audit export uses an explicit flat evidence-field allowlist. Unknown, nested,
prompt, content, argument, credential, and secret fields are dropped. Actor
labels that do not match the internal actor grammar are normalized to
`system:unknown`.

## Consequences

- Legitimate command executable upgrades require a new exact plan approval.
- Backups consume space for unique referenced artifact content, not every
  snapshot, and still do not back up the user's project or Git repository.
- Restore enforces writer exclusion without adding a daemon or multi-user
  authentication system.
- Pause is an operator action, not an automatic scheduler or kill policy.
- Very large or redirecting model endpoints must be corrected or explicitly
  configured within the documented ceiling.
- OS sandboxing, signed binaries, SBOM publication, hosted disaster recovery,
  dead-letter policy, and active-run termination remain separate work.

## Verification

- Command adapter unit tests cover digest mismatch, bounded environment, and
  dedicated cwd; CLI E2E verifies the planned digest and actual cwd.
- Backup tests cover DB integrity, artifact-set hashing, blob corruption, and
  migration snapshots. Restore E2E covers artifact restoration and safety
  backup creation.
- Maintenance tests cover new and already-open writers. Control Plane and CLI
  tests cover human pause/resume.
- HTTP adapter tests cover `redirect: error` and response overflow.
- Audit tests prove unknown and nested payload fields and invalid actor labels
  are absent from export.
