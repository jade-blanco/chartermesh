# Operating workflow

The CLI and dashboard are two clients of the same SQLite Control Plane.

```text
request → triage → claim/run → immutable artifact → exact human review
        → complete → resurface successors
                      ↘ fail → retry → new generation
```

## Intake and triage

```powershell
node bin/chartermesh.mjs request "Prepare release notes" `
  --summary "Draft concise notes for human review." `
  --target TARGET

node bin/chartermesh.mjs triage `
  --id work-000001 `
  --role operator `
  --execution-target local `
  --target TARGET
```

A role selects an execution target, not a raw model engine.

## Run

```powershell
node bin/chartermesh.mjs run --id work-000001 --target TARGET
```

Claiming atomically creates a Run, Attempt, time-bounded Lease, and increasing
generation. The runner requests a structured artifact, validates it, performs
at most one repair turn, and submits only from the active generation.

Lease heartbeats protect active work. Expired leases recover to a visible
`failed` state instead of leaving work permanently `in_progress`.

## Failure and retry

```powershell
node bin/chartermesh.mjs retry --id work-000001 --target TARGET
node bin/chartermesh.mjs run --id work-000001 --target TARGET
```

Each retry creates a new generation. Old workers cannot submit into it.

## Exact review

Inspect the artifact content and SHA-256, then bind the decision to that hash:

```powershell
node bin/chartermesh.mjs decide `
  --id work-000001 `
  --decision approve `
  --artifact-hash SHA256_FROM_RUN `
  --note "Acceptance criteria verified." `
  --target TARGET
```

Choices are `approve`, `changes_requested`, and `reject`. A model, subagent, or
host permission dialog cannot make the human decision.

## Complete

```powershell
node bin/chartermesh.mjs complete --id work-000001 --target TARGET
```

Only approved work can complete. Newly unblocked successors resurface exactly
once.

## Explicit waits

```powershell
node bin/chartermesh.mjs wait `
  --id work-000001 `
  --type user_input `
  --reason "Choose the deployment region." `
  --target TARGET
```

Wait types are `predecessor`, `not_before`, `user_input`, `manual_resume`, and
`approval`. Resume explicitly after the condition is satisfied:

```powershell
node bin/chartermesh.mjs resume --id work-000001 --target TARGET
```

## Dashboard

```powershell
node bin/chartermesh.mjs dashboard --target TARGET --port 4173
```

The inspector exposes the appropriate action for each state: triage, run,
retry, review, or complete. Review shows artifact content and exact hash.
Every action remains a Control Plane command with actor and idempotency.

## Machine-readable CLI

Agent-facing commands accept `--json` and return:

```json
{
  "apiVersion": "chartermesh.dev/cli/v1alpha1",
  "command": "list",
  "ok": true,
  "data": {}
}
```

Use `propose --json` before bootstrap. Parse `data.planHash` from the bootstrap
preview, show it to the human, and only apply after the human approves that
exact value.

## Budgets

Claims enforce the installed OrgSpec values:

- `maxConcurrentRuns`
- `maxDailyModelStarts`
- `monthlyCostLimitUsd`

Budget failures are stable error codes. They never trigger provider failover or
silent permission expansion.

## Sources of truth

- Desired organization/runtime: reviewable `.chartermesh/*.json`.
- Mutable runtime state: `.chartermesh/state.db`.
- Review evidence: content-addressed artifacts and hashes.
- UI counts: server-generated `DashboardProjection`.

Provider chats, native task lists, subagent messages, goals, threads,
worktrees, and schedules are capabilities or projections—not another ledger.
