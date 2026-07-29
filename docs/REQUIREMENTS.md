# Requirements traceability

Status values: `done`, `partial`, `planned`, `decision`.

| ID | Requirement | Phase | Evidence | Status |
|---|---|---:|---|---|
| ORG-001 | Versioned provider-neutral OrgSpec is the organization source of truth | 1 | schema, types, validator | done |
| ORG-002 | Provider-specific features are capability-gated | 1/4 | capability types and validator tests | partial |
| ORG-003 | Three proposal profiles: lean, balanced, controlled | 3 | proposal contract | planned |
| ENGINE-001 | Any compatible LLM can enter through the ModelEngine contract without Codex or Claude Code | 1/4 | fake and OpenAI-compatible adapters, managed-runner E2E | done |
| ENGINE-002 | Model capabilities and agent-host capabilities are negotiated independently | 1/4 | split manifests and validator tests | done |
| ENGINE-003 | Roles select an execution target, never a raw model engine | 1 | schema, types, reference validator | done |
| ENGINE-004 | The built-in ManagedRunner owns tool loop, workspace, approval pause/resume, and retries | 4 | contract present; implementation pending | partial |
| ENGINE-005 | Install approval binds the discovered capability snapshot as well as spec and plan | 1 | compiler plan hash test | done |
| PLAN-001 | Changes use plan, diff, approval, apply | 1 | compiler plan/apply tests | partial |
| PLAN-002 | Approval binds immutable spec and plan hashes | 1 | approval gate regression tests | done |
| DATA-001 | SQLite is the mutable runtime ledger | 2 | database bootstrap, Control Plane tests | done |
| DATA-002 | Events are append-only and command projections update atomically | 2 | command transactions and event projection tests | partial |
| RUN-001 | Claim creates Run, Attempt, and Lease atomically | 2 | Control Plane lifecycle test | done |
| RUN-002 | Fencing rejects stale workers | 2 | stale-generation artifact regression test | done |
| RUN-003 | No-work controller starts zero models | 2 | scheduler tests | planned |
| GOV-001 | Human approval cannot be replaced by a model or host prompt | 1/2 | schema, validator and apply gate | partial |
| GOV-002 | External side effects require a separate execution approval | 2 | policy state-machine tests | planned |
| GOV-003 | Permission-expanding provider fallback is rejected | 1/4 | validator test | done |
| COLLAB-001 | Native subagents and agent teams are host capabilities, not the ledger | 1/4 | product refresh, ADR 0005 | done |
| COLLAB-002 | Parent/child permissions do not satisfy human approval | 1/4 | ADR 0005; adapter contract tests | partial |
| COLLAB-003 | Parallel writes require worktree or file ownership isolation | 1/4 | validator test | done |
| COLLAB-004 | Child execution usage is measured or explicitly unknown | 2/4 | usage model and adapter tests | planned |
| COLLAB-005 | Goal/thread continuity is recoverable from the DB ledger | 2/4 | recovery tests | planned |
| COLLAB-006 | Experimental peer teams require explicit opt-in and drift checks | 1/4 | validator test and capability manifest | partial |
| SCHED-001 | Local, hosted, and chat-continuation schedules are distinct capabilities | 1/4 | ADR 0005, capability namespace | done |
| SCHED-002 | Native schedule is a projection with external id and drift | 2/4 | adapter contract | planned |
| SEC-001 | Secrets and private project markers are absent from distributable code | 0 | boundary scanner | done |
| SEC-002 | Local API defaults to loopback and least privilege | 2 | dashboard Host, Origin, token, media-type tests | done |
| UI-001 | Home prioritizes user actions, blockers, failures, and next runs | 5 | shared DashboardProjection and browser UI | partial |
| OSS-001 | CharterMesh name and Apache-2.0 are applied before publication | 0 | LICENSE, ADR 0007, package metadata | done |
| OSS-002 | Default tests are offline and free | all | `pnpm verify` | done |
| BOOT-001 | A coding agent can apply the repository from its URL and one natural-language request | 0/3 | BOOTSTRAP.md, AGENTS.md, CLAUDE.md, llms.txt | done |
| BOOT-002 | Bootstrap writes require approval of the exact current plan hash | 0/1 | CLI clean-target E2E | done |
| CLI-001 | Human and agent operators use the same CLI application flow | 2 | bootstrap, doctor, intake, run, review, complete E2E | done |
| REVIEW-001 | Review decisions bind the immutable current artifact hash | 2 | mismatched-evidence regression test | done |

## Engine/host separation acceptance tests

- An arbitrary conforming model engine binds to the built-in managed runner.
- A host-managed agent runtime rejects model-engine injection.
- A model capability cannot satisfy a missing host capability, or vice versa.
- Preferred and fallback execution targets satisfy the same split contract.
- A capability discovery change changes the install plan hash.
- Generic fake engine plus managed runner is the baseline E2E; proprietary host
  adapters are optional compatibility suites.

## Collaboration refresh acceptance tests

- Capability mismatch cannot silently downgrade `peer_team` or isolation.
- Experimental capabilities require a spec-level opt-in.
- A provider permission ceiling cannot increase during automatic fallback.
- A delegated writer with more than one worker requires isolated workspaces or
  explicit, non-overlapping file ownership.
- Host identifiers are references only; WorkItem and Run identifiers remain
  authoritative.
- Every child execution becomes an Attempt or an explicitly unknown usage
  record in Phase 2.
