# Implementation roadmap

Current milestone: `0.0.10-alpha.1`, project-type-aware one-setup onboarding,
verifiable Decision Packets, safe decision-review resume, provider-neutral
local operations, and bounded coding-agent host integration.

## Completed foundation

- Apache-2.0 TypeScript/pnpm monorepo
- Offline verification and private-data boundary scan
- Provider-neutral OrgSpec schema, dependency-free schema validation, semantic
  validation, canonical hashes, and capability negotiation
- Universal `BOOTSTRAP.md` application protocol
- Project-aware lean/balanced/controlled proposals
- Exact hash-bound plan and crash-recoverable journaled apply
- Cross-resource operation receipts that resume approved file and Control
  Plane settlement without duplicate kickoff work
- SQLite Control Plane with idempotency, append-only events, transactional
  outbox, runs, attempts, leases, artifacts, approvals, and usage
- Fencing, heartbeat, lease recovery, visible failure, retry, and budgets
- Fake and OpenAI-compatible engines
- Shell-free command-process ModelEngine with a bounded JSON contract,
  approved executable digest, and dedicated cwd
- Structured artifacts, repair turn, and cancellation propagation
- CLI and dashboard complete reviewed-work path
- Synthetic model evaluation
- Common Tool Runtime with OrgSpec allowlist, exact-call approval, workspace
  roots, evidence, and bounded iterations
- Crash-recoverable file transactions, no-write diagnostics, and explicit journal recovery
- Cross-process claim, idempotency, and SQLite lock stress suites
- Dependency-free JavaScript package build and clean-consumer install test
- Offline installation-version matching and explicit latest-release check
- Unknown-cost policy, user-supplied price estimates, and artifact limits
- Dashboard API rate limits and keyboard/mobile accessibility validation
- Allowlisted audit JSONL export
- Integrity-checked Control Plane DB+artifact backup, migration snapshots, and
  maintenance-locked approved restore with a pre-restore safety backup
- Explicit human pause/resume for new run claims
- Redirect-disabled and size-bounded HTTP model responses
- Full dependency-free runtime JSON Schema validation with reference checks
- Pre-call invocation records, cross-process/dashboard/signal cancellation,
  and abandoned-call recovery
- Cursor WorkItem pagination, terminal archive, and memory-bounded JSONL audit
  streaming
- Claim/retry/backoff/dead-letter outbox dispatcher with human replay
- Optional local interval scheduler, disabled by default, with overlap control
  and zero model starts on empty queues
- Four bundled Apache-2.0 Agent Skills installed by the approved bootstrap
  plan, plus agent-readable skill and integration catalog commands
- Optional bounded SearXNG search with exact-query approval and no commercial
  search API requirement
- Explicit small-model evidence discipline validated with local Gemma 4
- Experimental provider-neutral depth-1 delegation with planner, implementer,
  verifier, and synthesizer child Attempts
- Paired single-versus-delegated small-model collaboration evaluation
- Project-brief `kickoff` with one approved file plan and initial triaged work
- Local stdio MCP server over the authoritative Control Plane with unique
  session actors, exact run fencing, bounded governed change sets, and no
  human approval authority
- Hash-pinned Codex/Claude discovery plus deterministic project role, MCP, and
  instruction projection
- Codex app-server AgentHost v1alpha2 discovery/start/resume/events/result/cancel
  contract with durable run/session/turn binding and fail-closed approvals

## Next: execution hardening

- Crash-resumable child WorkItems, join latches, and independent child retry
- Attempt-level retry/dead-letter policy distinct from external outbox delivery
- Broader recurrence rules, durable service installation, and missed-tick
  policy for the local scheduler
- Provider failover canary with permission/capability revalidation
- More adversarial filesystem races and cross-user local-host testing

## Next: integration surfaces

- Resumable Control Plane approval callbacks for provider-native file and
  command requests; current Codex adapter cancels them fail-closed
- Direct Claude AgentHost adapter and compatibility tests; current Claude
  support is project-role and MCP projection only
- Provider-neutral MCP client lifecycle beyond local stdio, with credential
  binding and transport cancellation
- Projection of native AgentHost children into the same parent/child ledger
- Runtime capability discovery and drift reporting
- Registry release automation and clean-machine install/uninstall matrix

## Next: dashboard and release

- Run/attempt/usage history
- Organization and proposal diff views
- Schedule and audit views
- Automated screen-reader and visual-regression matrices
- Compatibility matrix for small/local and remote models
- Security review and release automation

Remote publication and npm publication are separately authorized actions. A
public source repository does not imply a package release.
