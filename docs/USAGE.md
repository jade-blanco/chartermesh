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

The Control Plane creates a `running` model invocation before handing control
to the engine. Success, failure, cancellation, and abandoned lease recovery
close that record explicitly, so an interrupted call is never silently
treated as zero-cost or as though it never started.

## Cancel an active run

```powershell
node bin/chartermesh.mjs cancel --id work-000001 --target TARGET --json
```

The dashboard cancel action, a second CLI process, and Ctrl+C/SIGTERM on the
foreground runner all write the same durable cancellation request. The
runner's abort signal is propagated to the ModelEngine, then the Attempt and
invocation are closed with visible cancellation evidence.

## Safe tool execution

The always-available tools are `workspace.list_files`,
`workspace.read_file`, and `workspace.write_file`. An approved installation
may also configure `web.search` through SearXNG. The runtime:

- offers only the assigned role's OrgSpec `tools.allow` entries;
- resolves paths beneath the declared relative `workspaceRoots`;
- rejects absolute paths, traversal, and symbolic-link targets;
- always requires exact-call approval for workspace writes;
- records call/input/output hashes, status, paths, and duration as Control
  Plane evidence;
- stops after OrgSpec `maxIterations`.

`web.search` is absent by default. When configured, it is treated as an
external side effect: the exact query hash must be approved before it leaves
the machine. The adapter refuses redirects, credentials in the endpoint, and
unbounded responses, and it returns search-result metadata without fetching
the linked pages.

An unapproved write pauses visibly without touching the file and prints its
canonical call hash. A human can approve that exact call, which returns the
WorkItem to ready, then start a new fenced run:

```powershell
node bin/chartermesh.mjs approve-tool `
  --id work-000001 `
  --call-hash CALL_SHA256 `
  --tool workspace.write_file `
  --note "Exact path and content hash reviewed." `
  --target TARGET

node bin/chartermesh.mjs run --id work-000001 --target TARGET
node bin/chartermesh.mjs tool-evidence --id work-000001 --target TARGET --json
```

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

The default view contains only current actionable work. Failed items remain
available from the failure or all-work filter, but do not inflate action or
human-review counts. The inspector exposes the appropriate action for each
state: triage, run, explicit failed-work retry, review, or complete. Review
shows artifact content and exact hash; requested changes show the latest human
review note.
Every action remains a Control Plane command with actor and idempotency.
Loopback requests also have separate per-minute limits for all APIs, mutations,
and model-run starts. A limited request returns `429` with `Retry-After`.

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
- `unknownCostPolicy` (`warn`, `block`, or `estimate`)
- `maxArtifactBytes`
- `maxWorkItemArtifactBytes`

Budget failures are stable error codes. They never trigger provider failover or
silent permission expansion.

Unknown cost is never converted to zero. The operator may provide input/output
token prices in runtime configuration, producing an `estimated` cost. The
`block` policy is conservative; `estimate` refuses to run without prices;
`warn` preserves unknown cost while allowing execution.

## Audit export

```powershell
node bin/chartermesh.mjs audit export --target TARGET --json
```

The output is JSONL under `.chartermesh/exports/` unless `--output` names
another path inside the target. Only documented ids, hashes, state labels,
engine/role labels, and timing evidence are exported. Unknown and nested
payload fields are dropped rather than copied and redacted. Existing files are
never overwritten. Export pages through the event ledger and appends JSONL
incrementally, so event growth does not require loading the entire audit
history into memory.

## Pagination and archive

The original `list` behavior remains available for compatibility. Long-lived
installations can request stable cursor pages and omit terminal work:

```powershell
node bin/chartermesh.mjs list --target TARGET --limit 100 --active-only --json
node bin/chartermesh.mjs list --target TARGET --limit 100 --cursor NEXT_CURSOR --json
```

Archiving is an explicit human action and is permitted only for `done` or
`canceled` WorkItems:

```powershell
node bin/chartermesh.mjs archive --id work-000001 --target TARGET
node bin/chartermesh.mjs list --target TARGET --include-archived --json
```

Archive hides terminal work from normal lists and the dashboard; it does not
delete WorkItems, Runs, artifacts, or audit evidence.

## Outbox delivery

External adapters can call the dependency-free `dispatchOutboxBatch` service.
Deliveries are claimed with an owner and stale-claim timeout, acknowledged on
success, retried with exponential backoff, and moved to dead-letter state
after the configured attempt bound. Operators can inspect and explicitly
requeue dead letters:

```powershell
node bin/chartermesh.mjs outbox list --target TARGET --dead-letters --json
node bin/chartermesh.mjs outbox retry --id DELIVERY_ID --target TARGET
```

CharterMesh does not start a network dispatcher by default; the adapter that
owns an external side effect must supply the delivery handler.

## Optional local scheduler

Default proposals have `schedules: []`, so no scheduler process or model starts
unless the operator adds and activates a controller schedule in an approved
OrgSpec. Run one evaluation or keep a local process watching:

```powershell
node bin/chartermesh.mjs scheduler tick --target TARGET --json
node bin/chartermesh.mjs scheduler list --target TARGET --json
node bin/chartermesh.mjs scheduler watch --target TARGET --poll-ms 30000
```

The first implementation supports dependency-free interval rules:
`FREQ=MINUTELY|HOURLY|DAILY;INTERVAL=N`. It enforces overlap policy and records
ticks. Before a model starts it queries for claimable work; an empty queue is
recorded as `skipped_no_work` and starts zero models. The watcher is a local
foreground process, not a service installed at boot.

## Control Plane backup and restore

```powershell
node bin/chartermesh.mjs backup create --target TARGET --json
node bin/chartermesh.mjs backup list --target TARGET --json
node bin/chartermesh.mjs restore --backup BACKUP_ID --target TARGET --json
```

`restore` first returns a no-write plan containing current and backup hashes.
Repeat with `--approve PLAN_HASH`. CharterMesh integrity-checks the selected
SQLite snapshot and every content-addressed artifact blob, requires the current
DB to still match the plan, creates a pre-restore safety backup, acquires a
persistent maintenance lock, checkpoints SQLite, and replaces the database and
referenced artifacts in one journaled file transaction. Existing processes may
continue reading, but new and already-open writers fail with
`CONTROL_PLANE_MAINTENANCE_ACTIVE` until restore releases the lock. Stop a
dashboard if its open SQLite sidecar prevents checkpointing.

This backs up `.chartermesh/state.db` and the artifacts it references, not the
user's Git repository or project files. Artifact blobs are deduplicated by
SHA-256 across backups. Unreferenced old artifact files may remain locally.

## Pause and resume new runs

```powershell
node bin/chartermesh.mjs system status --target TARGET --json
node bin/chartermesh.mjs system pause --reason "maintenance" --target TARGET
node bin/chartermesh.mjs system resume --target TARGET
```

Pause is off by default and requires an explicit human command. It blocks only
new claims with `OPERATIONS_PAUSED`; it does not cancel an active attempt,
change WorkItem state, or contact a provider.

## Sources of truth

- Desired organization/runtime: reviewable `.chartermesh/*.json`.
- Mutable runtime state: `.chartermesh/state.db`.
- Review evidence: content-addressed artifacts and hashes.
- UI counts: server-generated `DashboardProjection`.

Provider chats, native task lists, subagent messages, goals, threads,
worktrees, and schedules are capabilities or projections—not another ledger.
