# Handover

## Current state

- Product design is in `docs/PRODUCT-DESIGN.md` with native collaboration,
  engine/host separation, universal bootstrap, Control Plane, and action
  projection boundaries.
- OrgSpec, the SQLite Control Plane, the safe Tool Runtime, recoverable apply,
  operational backup/audit controls, the reviewed-work dashboard, and a
  dependency-free package build are present at `0.0.6-alpha.1`.
- `ModelEngine`, `AgentHost`, and `ManagedRunner` are separate contracts;
  generic and fake engines are the primary foundation, while Codex and Claude
  Code remain optional host adapters.
- The repository is package-ready and clean-install tested. No registry
  publication, provider login, paid call, deployment, or cloud resource has
  been performed.
- Apache-2.0 is selected and the standard license text is in `LICENSE`.

## Verify

```powershell
pnpm verify
git status --short
```

## Implemented local path

1. Agent-readable exact-hash bootstrap protocol.
2. SQLite Control Plane and action projection.
3. Fake, OpenAI-compatible, and shell-free command-process model engines.
4. Built-in managed runner with structured output, one repair turn, bounded
   tool execution, exact-call write approval, and evidence hashes.
5. Crash-recoverable file transactions and multi-process SQLite stress tests.
6. CLI lifecycle and responsive loopback dashboard.
7. Dependency-free JavaScript package build and temporary-consumer install
   verification.
8. Unknown-cost policy and estimates, artifact limits, dashboard rate limits,
   allowlisted audit export, and approved DB+artifact restore.
9. Executable-digest-pinned command engines, dedicated engine cwd,
   maintenance lock, explicit new-run pause/resume, and bounded no-redirect
   HTTP responses.
10. Runtime schema validation, durable invocation start/finish and shared
    cancellation, cursor pagination/archive, streaming audit export, retryable
    outbox delivery, and an opt-in no-work-safe local scheduler.

## Next implementation slice

1. Add attempt-level retry/dead-letter policy distinct from the external
   outbox.
2. Extend the local scheduler beyond interval RRULEs and define missed-tick
   service-installation behavior.
3. Add provider failover canaries with permission revalidation.
4. Add command/network tools only behind separate policy and sandbox ADRs.
5. Add a second protocol-native HTTP ModelEngine adapter and optional AgentHost
   adapters without changing the core ledger.
6. Add signed release/SBOM automation and a clean-OS compatibility matrix.

## Rollback

Database migration 7 marks the durable-runtime slice; older known schemas
receive an automatic SQLite snapshot before migration. File transactions
recover automatically from `.chartermesh/.transactions`; use
`chartermesh recover` rather than deleting journal or backup files. Revert
future source changes with a new commit; do not delete user files or rewrite
Git history when rolling back.
