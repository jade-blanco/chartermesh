# Implementation roadmap

Current milestone: `0.0.2-alpha.1`, provider-neutral structured execution.

## Completed foundation

- Apache-2.0 TypeScript/pnpm monorepo
- Offline verification and private-data boundary scan
- Provider-neutral OrgSpec schema, dependency-free schema validation, semantic
  validation, canonical hashes, and capability negotiation
- Universal `BOOTSTRAP.md` application protocol
- Project-aware lean/balanced/controlled proposals
- Exact hash-bound plan and staged rollback-on-error apply
- SQLite Control Plane with idempotency, append-only events, transactional
  outbox, runs, attempts, leases, artifacts, approvals, and usage
- Fencing, heartbeat, lease recovery, visible failure, retry, and budgets
- Fake and OpenAI-compatible engines
- Structured artifacts, repair turn, and cancellation propagation
- CLI and dashboard complete reviewed-work path
- Synthetic model evaluation

## Next: execution hardening

- Crash-safe apply recovery after process termination, not only exceptions
- General tool-execution loop with policy enforcement and tool evidence
- Attempt-level dead-letter policy and global kill switch
- No-work scheduler and empty-start accounting
- Provider failover canary with permission/capability revalidation
- Cross-process concurrency and idempotency stress suites

## Next: integration surfaces

- MCP server over the same Control Plane application service
- Command-based local model adapter
- Optional external AgentHost adapters
- Runtime capability discovery and drift reporting
- Package-manager distribution and clean-machine install/uninstall

## Next: dashboard and release

- Run/attempt/usage history
- Organization and proposal diff views
- Schedule and audit views
- Keyboard, responsive, browser accessibility, and visual regression suites
- Compatibility matrix for small/local and remote models
- Security review and release automation

Remote publication and npm publication are separately authorized actions. A
public source repository does not imply a package release.
