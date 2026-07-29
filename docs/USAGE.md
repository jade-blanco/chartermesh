# Operating workflow

CharterMesh operates one command-driven lifecycle. The CLI and dashboard are
two views over the same SQLite Control Plane.

```text
request → triage → claim/run → submit immutable artifact
        → exact human review → complete → resurface successors
```

## 1. Intake

```powershell
node bin/chartermesh.mjs request "Prepare release notes" `
  --summary "Draft concise notes for human review." `
  --target TARGET
```

The WorkItem starts as `requested`. Its next action is assignment, not model
execution.

## 2. Triage

```powershell
node bin/chartermesh.mjs triage `
  --id work-000001 `
  --role operator `
  --execution-target local `
  --target TARGET
```

Triage selects a role and an execution target. A role never binds directly to
a raw model engine.

## 3. Run

```powershell
node bin/chartermesh.mjs run --id work-000001 --target TARGET
```

Claiming atomically creates:

- a `Run`;
- an `Attempt`;
- a time-bounded `Lease`;
- a monotonically increasing generation.

The built-in managed runner calls the configured model engine once. The result
can be submitted only by the active generation. CharterMesh stores it under a
content hash and prints that SHA-256 hash.

## 4. Review the exact artifact

Inspect the submitted result, then bind the decision to the printed hash:

```powershell
node bin/chartermesh.mjs decide `
  --id work-000001 `
  --decision approve `
  --artifact-hash SHA256_FROM_RUN `
  --note "Acceptance criteria verified." `
  --target TARGET
```

Decisions are `approve`, `changes_requested`, or `reject`. A model, subagent,
or host permission prompt cannot supply the human decision. A hash mismatch is
rejected.

## 5. Complete

```powershell
node bin/chartermesh.mjs complete --id work-000001 --target TARGET
```

Only approved work can complete. Completion checks dependent WorkItems and
resurfaces each newly unblocked successor exactly once.

## Explicit waits

Every wait has a type and a reason:

```powershell
node bin/chartermesh.mjs wait `
  --id work-000001 `
  --type user_input `
  --reason "Choose the deployment region." `
  --target TARGET
```

Supported types are:

- `predecessor`
- `not_before` with `--resume-at`
- `user_input`
- `manual_resume`
- `approval`

Waiting work remains visible in the dashboard but is excluded from the
actionable count unless the user must provide input or review.

After the stated condition is satisfied, resume it explicitly:

```powershell
node bin/chartermesh.mjs resume --id work-000001 --target TARGET
```

`not_before` and predecessor waits refuse early resume while their conditions
remain unsatisfied.

## Dashboard

```powershell
node bin/chartermesh.mjs dashboard --target TARGET --port 4173
```

The Today view orders user actions as:

1. human review;
2. user input;
3. failures and retry;
4. unassigned intake;
5. requested changes and resume;
6. ready-to-start work;
7. visible non-actionable waits.

Selecting a row opens its inspector. Creating a request sends one idempotent
Control Plane command; the browser never edits state rows directly.

## Useful commands

```powershell
node bin/chartermesh.mjs help
node bin/chartermesh.mjs doctor --target TARGET
node bin/chartermesh.mjs list --target TARGET
node bin/chartermesh.mjs seed-demo --target TARGET
```

## What is authoritative

- Desired organization and runtime configuration: reviewable JSON files.
- Mutable runtime state: `.chartermesh/state.db`.
- Review evidence: content-addressed artifacts and immutable hashes.
- UI counts: server-generated Control Plane projection.

Provider chats, native task lists, agent-team messages, goals, threads,
worktrees, and schedules are integrations or runtime capabilities. They are
not a second WorkItem ledger.
