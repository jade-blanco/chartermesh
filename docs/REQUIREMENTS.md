# Requirements traceability

Status values: `done`, `partial`, `planned`, `decision`.

| ID | Requirement | Phase | Evidence | Status |
|---|---|---:|---|---|
| ORG-001 | Versioned provider-neutral OrgSpec is the organization source of truth | 1 | schema, types, validator | done |
| ORG-002 | Provider-specific features are capability-gated | 1/4 | capability types and validator tests | partial |
| ORG-003 | Three proposal profiles: lean, balanced, controlled | 3 | target assessment, proposal hashes, CLI E2E | done |
| ENGINE-001 | Any compatible LLM can enter through the ModelEngine contract without Codex or Claude Code | 1/4 | fake, OpenAI-compatible, and command-process adapters; managed-runner E2E | done |
| ENGINE-002 | Model capabilities and agent-host capabilities are negotiated independently | 1/4 | split manifests and validator tests | done |
| ENGINE-003 | Roles select an execution target, never a raw model engine | 1 | schema, types, reference validator | done |
| ENGINE-004 | The built-in ManagedRunner owns structured execution, workspace boundary, approval enforcement, and retries | 4 | structured artifact, tool-loop, repair/cancel tests | done |
| ENGINE-005 | Install approval binds the discovered capability snapshot as well as spec and plan | 1 | compiler plan hash test | done |
| PLAN-001 | Changes use plan, diff, approval, journaled apply, and recovery | 1 | compiler plan/apply and forced-exit recovery tests | done |
| PLAN-002 | Approval binds immutable spec and plan hashes | 1 | approval gate regression tests | done |
| DATA-001 | SQLite is the mutable runtime ledger | 2 | database bootstrap, Control Plane tests | done |
| DATA-002 | Events are append-only and command projections update atomically | 2 | command transactions, events, transactional outbox | done |
| RUN-001 | Claim creates Run, Attempt, and Lease atomically | 2 | Control Plane lifecycle test | done |
| RUN-002 | Fencing rejects stale workers | 2 | stale-generation artifact regression test | done |
| RUN-003 | No-work controller starts zero models | 2 | scheduler unit and CLI E2E invocation-count tests | done |
| GOV-001 | Human approval cannot be replaced by a model or host prompt | 1/2 | schema, install gate, tool-call approval actor checks | done |
| GOV-002 | External side effects require a separate execution approval | 2 | policy state-machine tests | planned |
| GOV-003 | Permission-expanding provider fallback is rejected | 1/4 | validator test | done |
| COLLAB-001 | Native subagents and agent teams are host capabilities, not the ledger | 1/4 | product refresh, ADR 0005 | done |
| COLLAB-002 | Parent/child permissions do not satisfy human approval | 1/4 | ADR 0005; adapter contract tests | partial |
| COLLAB-003 | Parallel writes require worktree or file ownership isolation | 1/4 | validator test | done |
| COLLAB-004 | Child execution usage is measured or explicitly unknown | 2/4 | delegated Attempt and Invocation lifecycle tests | done |
| COLLAB-005 | Goal/thread continuity is recoverable from the DB ledger | 2/4 | lease recovery and retry generation tests | partial |
| COLLAB-006 | Experimental peer teams require explicit opt-in and drift checks | 1/4 | validator test and capability manifest | partial |
| SCHED-001 | Local, hosted, and chat-continuation schedules are distinct capabilities | 1/4 | ADR 0005, capability namespace | done |
| SCHED-002 | Native schedule is a projection with external id and drift | 2/4 | adapter contract | planned |
| SEC-001 | Secrets and private project markers are absent from distributable code | 0 | boundary scanner | done |
| SEC-002 | Local API defaults to loopback and least privilege | 2 | dashboard Host, Origin, all-API token, media-type tests | done |
| UI-001 | Home prioritizes user actions, blockers, failures, and next runs | 5 | shared projection and full reviewed-work dashboard actions | partial |
| OSS-001 | CharterMesh name and Apache-2.0 are applied before publication | 0 | LICENSE, ADR 0007, package metadata | done |
| OSS-002 | Default tests are offline and free | all | `pnpm verify` | done |
| BOOT-001 | A coding agent can apply the repository from its URL and one natural-language request | 0/3 | BOOTSTRAP.md, AGENTS.md, CLAUDE.md, llms.txt | done |
| BOOT-002 | Bootstrap writes require approval of the exact current plan hash | 0/1 | CLI clean-target E2E | done |
| CLI-001 | Human and agent operators use the same CLI application flow | 2 | bootstrap, doctor, intake, run, review, complete E2E | done |
| CLI-002 | Agent-facing commands expose a stable versioned JSON envelope | 2 | proposal/bootstrap/workflow JSON CLI E2E | done |
| REVIEW-001 | Review decisions bind the immutable current artifact hash | 2 | mismatched-evidence regression test | done |
| RUN-004 | Failed or abandoned runs become visible and retry with a new generation | 2 | failure, expired-lease recovery, retry tests | done |
| GOV-004 | Installed run/start/cost budgets are enforced before claim | 2 | Control Plane budget tests | done |
| EVAL-001 | Local models can be compared with synthetic, project-private-data-free tasks | 4 | evaluate-model command and evaluation contract | done |
| TOOL-001 | OrgSpec allowlist, roots, approvals, evidence, and max iterations gate every common tool call | 4 | Tool Runtime and Control Plane evidence tests | done |
| RECOVERY-001 | File apply survives process termination and recovers explicitly from its journal | 1/3 | forced process exit, no-write doctor report, explicit recovery E2E | done |
| CONCURRENCY-001 | Multiple processes cannot double-claim or split one idempotent command | 2 | 16-process claim and replay stress tests | done |
| DIST-001 | A dependency-free package installs and bootstraps in a clean temporary consumer | 6 | `pnpm pack:check` | done |
| DIST-002 | Running CLI detects target/CLI version mismatch without network access | 6 | `doctor`, `version` | done |
| COST-001 | Unknown model cost is explicit and follows an operator-owned policy | 2/4 | OrgSpec validation, pricing adapter tests, pre-claim checks | done |
| ARTIFACT-001 | Artifact evidence has individual and work-item byte bounds | 2 | Control Plane limit tests | done |
| AUDIT-001 | Audit data can be exported without raw or unknown payload fields | 2/5 | allowlisted JSONL projection and tests | done |
| BACKUP-001 | Control Plane migration and restore have verified local DB+artifact snapshots | 2/6 | integrity/artifact-set/hash tests and restore CLI E2E | done |
| API-001 | Loopback dashboard applies bounded API, mutation, and run rates | 2/5 | HTTP 429 regression test | done |
| UI-002 | Keyboard and mobile inspector flows preserve focus and hidden-state semantics | 5 | in-app Browser desktop/mobile QA | done |
| ENGINE-006 | Local command engines execute only an approved executable digest from a dedicated cwd | 4 | command adapter unit and CLI E2E | done |
| OPS-001 | Restore rejects concurrent writers and operators can explicitly pause new run claims | 2/6 | maintenance and pause unit/CLI tests | done |
| HTTP-001 | HTTP model inference rejects redirects and oversized response bodies | 4 | OpenAI-compatible adapter tests | done |
| CONFIG-001 | Runtime JSON is schema-validated before adapter load or inference | 1/4 | dependency-free parser and invalid-runtime CLI E2E | done |
| RUN-005 | Model invocation is durable before call and closes on success, failure, cancellation, or abandonment | 2/4 | invocation lifecycle and cancellation E2E | done |
| RUN-006 | CLI, dashboard, and foreground signals use one durable cancellation command | 2/5 | service, dashboard, and separate-CLI cancellation tests | done |
| DATA-003 | Work lists page by stable cursor and terminal archive does not delete evidence | 2/5 | pagination/archive Control Plane and dashboard tests | done |
| AUDIT-002 | Audit export is memory-bounded as event history grows | 2/5 | paged projection and incremental JSONL writer | done |
| OUTBOX-001 | Outbox delivery claims, retries, dead-letters, and permits explicit human replay | 2/4 | dispatcher and Control Plane tests | done |
| SCHED-003 | Local controller scheduling is opt-in, overlap-aware, and records durable ticks | 2/4 | scheduler runtime, Control Plane ticks, CLI E2E | done |
| SKILL-001 | Provider-neutral organization, evidence, and research skills install through the approved bootstrap plan | 0/4 | six Apache-2.0 SKILL.md packages, package and CLI E2E | done |
| CATALOG-001 | External agent integrations expose source, license, prerequisites, permissions, risks, and disabled state | 0/4 | capability catalog and CLI JSON tests | done |
| WEB-001 | Optional search is provider-neutral, bounded, allowlisted, and exact-query approved before egress | 4 | SearXNG adapter, config schema, approval and loopback HTTP tests | done |
| MCP-001 | Generic MCP client projects capabilities through the Control Plane rather than bypassing it | 4 | ADR 0015 | planned |
| EVAL-002 | ManagedRunner separates performed checks from unperformed verification for constrained models | 4 | prompt regression and local Gemma workflow | done |
| COLLAB-007 | A provider-neutral ManagedRunner can execute bounded depth-1 delegation without an AgentHost | 2/4 | DelegationController, child Attempt lineage, CLI E2E | done |
| EVAL-003 | Single and delegated small-model work are compared on paired synthetic company tasks with an honest generation budget ceiling | 4 | evaluate-collaboration contract and scripted-engine test | done |

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
- Every built-in delegated child execution becomes an Attempt and durable model
  invocation. Native AgentHost children still require adapter-specific
  projection before they can make the same claim.
