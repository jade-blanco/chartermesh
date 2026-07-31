# CharterMesh dashboard design contract

Status: accepted through `0.0.6-alpha.1`.

The dashboard is a local projection and command client for the SQLite Control
Plane. It is never a second task ledger.

## Product questions

The first screen answers:

1. What needs a human decision now?
2. What can a role or runner start or resume?
3. What is waiting, why, and what will make it visible again?
4. What failed and can be retried safely?

## Implemented interaction

- Create an idempotent request.
- Triage unassigned work.
- Run ready or change-requested work.
- Request durable cancellation of an active run without blocking the HTTP
  response for the full model call.
- Inspect immutable artifact content and exact SHA-256.
- Approve, request changes, or reject.
- Inspect failed history and explicitly recover it to ready when a human chooses
  to retry it. Failure does not count as current action or human review.
- Complete approved work.
- Archive completed or canceled work without deleting its evidence.
- Default to actionable work, with explicit filters for all, waiting, failed,
  and completed work.

An exact tool approval appears under human review only while its WorkItem is
actively waiting for that hash. A failed WorkItem may retain the historical
pending-call record for audit, but the dashboard must not present that record
as an approval request. `changes_requested` displays the latest reviewer note
and is categorized as role/runner rework, not human review.

The inspector derives actions from server-projected state. The browser does not
edit database rows or invent transitions.

## Information architecture

- Today: summary, cursor-bounded prioritized work, inspector, runtime health.
- Work: same table and inspector.
- Approvals: exact artifact review.
- Runs & schedules, Organization, and Activity: reserved follow-on areas.

## Security and privacy

- Bind loopback only.
- Validate `Host`.
- Require the per-process session token on every API read and mutation.
- Require allowed `Origin`, JSON content type, bounded body, and idempotency on
  mutations.
- Never return credentials, environment values, artifact paths, database
  paths, or absolute target paths.
- Never let a model action approve its own result.

## Accessibility and responsive behavior

- Status is represented by text and color.
- Native buttons, dialog, inputs, headings, and focus rings are used.
- Desktop shows navigation, main canvas, and inspector.
- Narrow screens use work cards and a bottom-drawer inspector.
- Primary controls retain a minimum 44-pixel target in the main interface.

Automated browser accessibility testing remains release-hardening work.
