# ADR 0009: Universal bootstrap and action-centric Control Plane projection

- Status: accepted
- Date: 2026-07-29

The action projection is refined by ADR 0020. Human decisions and role actions
are now separate queues, and exact decisions are bound to a server-generated
Decision Packet in addition to the artifact or tool-call hash.

## Context

The product must be applicable when a user gives any capable coding agent the
repository URL and a short request. Provider-specific prompt files cannot be
the installation contract. Updated operational-console experience also showed
that a flat status list hides the user's actual next decision, and that
provider-native chats or shared task lists are not durable enough to own work
state.

## Decision

`BOOTSTRAP.md` is the provider-neutral application protocol. `AGENTS.md`,
`CLAUDE.md`, and `llms.txt` are discovery entry points that refer to it.
Bootstrap uses the repository CLI for a no-write plan, binds existing target
content into a deterministic hash, requires a human to approve that exact hash,
then applies and runs `doctor`.

The SQLite Control Plane is the only mutable WorkItem ledger. State changes are
commands with actor and idempotency. Claim creates a Run, Attempt, and Lease in
one transaction. Artifact submission is fenced by run generation. Human review
binds the exact immutable artifact hash.

The dashboard consumes a server-generated `DashboardProjection`. It derives
`UserAction` objects that prioritize human review, user input, triage, resume,
and start. A failed WorkItem is retained as inspectable history and may expose
an explicit manual retry, but is not counted as actionable or human review.
Explicit waits remain visible and state why and when they can resume, but
non-actionable waits do not inflate the actionable count.

The default dashboard filter shows actionable work. Human review includes only
an active artifact decision or exact tool-call approval that currently blocks
progress. `changes_requested` is role/runner rework rather than another human
review; the latest human review note remains visible beside that work.

## Consequences

- A user can begin with a repository URL and one sentence regardless of the
  coding-agent host.
- The agent must pause once for approval after the plan exists.
- CLI and dashboard behavior cannot diverge into separate ledgers.
- Provider-specific collaboration features remain adapter capabilities.
- New dashboards must preserve the action and wait semantics even if their
  visual design changes.
- The first UI is loopback-only and exposes no internal paths or credentials.
