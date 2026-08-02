# CharterMesh dashboard design contract

Status: accepted through the Decision Desk `v1alpha1` vertical slice.

The dashboard is a local projection and command client for the SQLite Control
Plane. It is never a second task ledger.

## Product questions

The first screen answers, in this order:

1. What needs a human decision now?
2. What evidence is verified, what is only producer-reported, and what remains
   unknown for that one decision?
3. What can a role or runner start or resume?
4. What is waiting, why, and what will make it visible again?
5. What is preserved as completed, canceled, or failed history?

## Implemented interaction

- Create an idempotent request.
- Triage unassigned work.
- Run ready or change-requested work.
- Request durable cancellation of an active run without blocking the HTTP
  response for the full model call.
- Inspect immutable artifact content and exact SHA-256.
- Inspect a server-generated Decision Packet bound to the work contract,
  subject, evidence set, criteria, and exceptions.
- Approve and complete, request changes with a required actionable reason, or
  reject. The next human decision becomes the focus after submission.
- Approve an exact tool call only with its current packet hash.
- Provide requested user input only against its exact packet hash; the response
  becomes bounded Control Plane state and reaches the next runner context.
- Inspect failed history and explicitly recover it to ready when a human chooses
  to retry it. Failure does not count as current action or human review.
- Complete approved work in the same dashboard decision when the approved
  subject is the deliverable itself. This never grants a separate side effect.
- Archive completed or canceled work without deleting its evidence.
- Default to human decisions, with separate filters for agent work, waiting,
  history, and all work.
- Refresh visible state every five seconds without polling while a decision
  dialog is open or the document is hidden.

An exact tool approval or rejection appears under human review only while its WorkItem is
actively waiting for that hash. A failed WorkItem may retain the historical
pending-call record for audit, but the dashboard must not present that record
as an approval request. `changes_requested` displays the latest reviewer note
and is categorized as role/runner rework, not human review.

The inspector derives actions from server-projected state. The browser does not
edit database rows, parse raw artifacts into decision truth, or invent evidence
status. Producer-reported checks are labelled as claims. Only current-run Tool
Runtime evidence can be labelled verified in this vertical slice;
`host_validator` is reserved for a future ingestion path.

## Information architecture

- Decision Desk: one global primary human decision, compact queue summaries,
  cursor-bounded operational work, inspector, runtime health.
- Work: same table and inspector.
- Human decisions: artifact review, exact tool-call approval, and requested
  user input. Human counts and the primary decision are independent of the
  newest-work cursor page.
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
- Require the exact current `packetHash` as well as the artifact/call hash.
- Treat client active-review time and detail-open count as local estimated UX
  metrics for completed decisions, never as security evidence, complete wall
  time, or decision correctness.
- Warn that requested input is stored locally and passed to the next runner;
  credentials, API keys, passwords, and tokens must use a separate secret
  channel rather than the input form.

## Accessibility and responsive behavior

- Status is represented by text and color.
- Native buttons, dialog, inputs, headings, and focus rings are used.
- Desktop shows navigation, main canvas, and inspector.
- Narrow screens use work cards and a bottom-drawer inspector.
- Primary controls retain a minimum 44-pixel target in the main interface.

Automated browser accessibility testing remains release-hardening work.
