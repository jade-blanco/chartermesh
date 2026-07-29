# Implementation roadmap

Current milestone: `0.0.1-alpha.1` runnable local vertical slice.

## Phase 0 — independent foundation

Deliverables:

- Git repository, CharterMesh name, safety guidance
- TypeScript/pnpm monorepo boundary
- CI, offline test command, private-data boundary scan
- Product design, ADRs, requirements traceability, handover
- Apache-2.0 license and public name recorded

Done when `pnpm verify` passes on the supported local Node.js version and no
forbidden private marker exists in distributable paths.

## Phase 1 — OrgSpec vertical slice

Deliverables:

- OrgSpec v1alpha1 schema, parser, types, canonical hash
- Deterministic semantic validator
- Synthetic balanced organization
- Structural diff and InstallPlan
- Exact spec/plan hash approval gate
- Rollback plan contract

Done when valid fixtures pass, unsafe fixtures fail with stable error codes,
unapproved apply fails, changed candidates invalidate approval, and tests use no
network or paid model.

## Phase 2 — Control Plane

Deliverables:

- SQLite WAL migrations and repository boundary
- WorkItem, Run, Attempt, Lease, Artifact, Approval, Event, UsageRecord
- Transactional outbox, optimistic concurrency, idempotency
- Scheduler, heartbeat, retry, dead letter, pause and kill switch
- CLI, MCP, and REST over one application service layer

Current status: the SQLite command service, core lifecycle, CLI, and
loopback-only dashboard API are implemented. Transactional outbox, heartbeat,
dead letter, kill switch, and MCP remain.

Done when concurrency, fencing, crash recovery, approval pause/resume,
no-change reads, and no-work-no-model tests pass.

## Phase 3 — C-level bootstrap

Deliverables:

- Read-only environment capability inspection
- Goal, risk, approval, budget, and schedule interview
- Lean, balanced, and controlled proposals
- Structured OrgSpec-only model output
- UserAction generation for unsupported or manual setup

Done when unsafe or invalid model output cannot reach plan/apply.

## Phase 4 — engines and hosts

Order:

1. Fake `ModelEngine` and fake `ManagedRunner`
2. Built-in `ManagedRunner`
3. Generic model API and command `ModelEngine` adapters
4. User-selected external `AgentHost`
5. A second engine or host compatibility adapter

Model and host manifests are discovered independently. The managed runner must
work without Codex or Claude Code. Optional Codex and Claude Code manifests
distinguish stable, beta, experimental, manual-only, local, hosted, and
chat-continuation capabilities. Native subagents, agent teams, goals, threads,
worktrees, and schedules remain host-adapter implementation choices.

Done when the generic engine plus built-in runner completes the baseline E2E,
and contract, drift, permission non-escalation, child cleanup, usage accounting,
and failover canary tests pass.

Current status: items 1–3 have a single-turn text implementation and offline
E2E. Tool loops, command-based engines, external AgentHosts, cancellation
propagation, and failover remain.

## Phase 5 — dashboard

Priority:

1. User actions and blockers
2. Proposal and plan diff
3. Approvals and artifact evidence
4. Work and dependencies
5. Schedules and runs
6. Usage, retries, handoffs, and empty starts
7. Audit history

Done when keyboard, responsive, accessibility, and E2E tests pass.

Current status: the Today action projection, filters, inspector, runtime health,
new-request dialog, responsive layout, and API security test are implemented.
Full review, run history, schedule, usage, and browser accessibility suites
remain.

## Phase 6 — burn-in and release

- Synthetic software-development and research packs
- Clean-machine install and uninstall
- Crash/resume, provider failover, schedule drift, rollback
- Compatibility matrix and security review
- Public name, disclosure address, release and telemetry policy

Remote publication and package publication remain separately authorized
actions. A public source repository does not imply an npm package release.
