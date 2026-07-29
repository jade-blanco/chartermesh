# ADR 0012: Local operational safety and command-process engines

- Status: accepted
- Date: 2026-07-29

The command-process, audit-export, and backup/restore boundaries in this ADR
are refined by ADR 0013.

## Context

CharterMesh enforced run counts and recorded cost, but a provider that omitted
price data made a monthly cost ceiling impossible to interpret. Artifact
content had no explicit operational byte budget. The local dashboard had strong
origin/session checks but no request-rate boundary. Operators could inspect
events and copy SQLite manually, but there was no safe audit export or
hash-approved restore.

The OpenAI-compatible adapter also left local runtimes without that HTTP
protocol needing a custom in-core integration, contrary to the
provider-neutral boundary.

## Decision

### Operator-owned cost policy

OrgSpec budgets add `unknownCostPolicy` with `warn`, `block`, and `estimate`.
Omission remains `warn` for v1alpha1 compatibility. New proposals write it
explicitly.

CharterMesh does not ship vendor prices. The runtime may store operator-supplied
input/output prices per million tokens. A computed cost is marked `estimated`,
never `measured`. `estimate` refuses an engine without prices. `block` refuses
an unknown-cost engine and later claims if the month already contains a null
cost. `warn` permits the run and preserves null. Provider-side billing limits
remain the only hard reservation for a bill not yet incurred.

### Operational bounds and export

OrgSpec may set per-artifact and cumulative per-WorkItem byte limits. Safe
defaults apply when older v1alpha1 specs omit them.

The loopback dashboard applies in-memory fixed-window limits separately to all
API requests, mutations, and run starts after session authentication.

The Control Plane exposes a chronological audit projection. Exported JSONL
retains ids, actors, timestamps, hashes, types, and safe payload fields while
recursively replacing secret-, token-, prompt-, content-, and argument-like
fields.

### Backup and restore

SQLite snapshots use `DatabaseSync.serialize()`, SHA-256, byte length, schema
version, work-item count, and `PRAGMA integrity_check`. Opening an older known
schema creates a pre-migration snapshot. Manual backup create/list are local
commands.

Restore is a separate exact-hash plan. Applying it requires the current
database to still match the approved plan, creates a pre-restore safety
snapshot, checkpoints/closes SQLite, and replaces the DB through the common
journaled file transaction. It does not back up the user's Git repository.

### Command-process ModelEngine

An arbitrary local executable may implement the neutral request/result
contract. The executable path is absolute; it is spawned with `shell: false`,
the target project as cwd, a minimal plus explicitly allowed environment, a
timeout, and a 1 MiB combined output ceiling. stderr is never copied into
Control Plane error messages. The managed runner still owns structured
artifact validation, tool policy, repair, and submission.

## Consequences

- Cost control is honest about information the operator or provider has not
  supplied.
- Operational history can be exported and the local ledger recovered without
  implying a hosted backup service.
- Local runtimes can integrate without Anthropic, Gemini, OpenAI, Codex, or
  Claude being a core dependency.
- A command-process wrapper is trusted local code, not a sandbox. Tool
  authority remains in the common runtime; the wrapper itself must be reviewed.
- Dashboard rate state is per process and is not a multi-user authentication
  or distributed rate-limit system.

## Verification

- Adapter tests cover price estimates and bounded command environment.
- Control Plane tests cover artifact limits, audit redaction, backup hash and
  integrity, and pre-migration backup.
- CLI E2E covers command-process execution and exact-plan restore with a safety
  backup.
- HTTP tests cover `429` and `Retry-After`.
- In-app Browser QA covers desktop/mobile rendering, filter pressed state,
  dialog and inspector focus/escape return, hidden mobile inspector semantics,
  and zero browser warnings/errors.
