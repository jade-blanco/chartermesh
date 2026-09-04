# Handover

## Current state

- Product design is in `docs/PRODUCT-DESIGN.md` with native collaboration,
  engine/host separation, universal bootstrap, Control Plane, and action
  projection boundaries.
- OrgSpec, the SQLite Control Plane, the safe Tool Runtime, recoverable apply,
  operational backup/audit controls, the reviewed-work dashboard, and a
  dependency-free package build are present. The current prerelease is
  `0.0.10-alpha.1`; its GitHub package can be used without a manual checkout.
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
11. Decision Packet v1alpha2, artifact-producer sidecars, decision-centered
    operator queues, and the fixed decision-review proxy benchmark.
12. Checkpointed benchmark resume with exact plan/suite/config hashes, segment
    lineage, invocation-prefix verification, and fail-closed interruption
    handling.
13. Fresh-project kickoff, namespaced Codex/Claude role projection, a required
    local MCP bridge, exact-fenced multi-file approvals, and the direct Codex
    AgentHost v1alpha2 slice.
14. Project-type team templates, generated team design and human-readable team
    charter, copy/paste handoffs, exact approval rules, and same-plan
    Codex/Claude project-role projection.
15. Plain-language-first human approvals with exact evidence and authority
    boundaries retained; ELI5 is the default rather than a quality guarantee.
16. Read-only `project-config` and exact-approved `configure-project` for saved
    preferences and complete validated organization revisions. Customized
    projects are protected from ordinary bootstrap overwrites; connection
    changes preserve their advisory preferences. Active execution blocks changes,
    unfinished work must retain valid references, and work state is hash-bound.
    Native projection refresh supports one re-attested Codex or Claude host,
    retires removed roles, and requires a fresh session.

The customization contract and constraints are in
`docs/PROJECT-CUSTOMIZATION.md` and ADR 0025. It does not weaken current approval
policy, change connection/schedule authority, train models, or create a second
work ledger. ELI5 can be explicitly refined to concise or technical presentation
without dropping hashes, risk disclosure, or claimed-versus-verified status.
Release verification uses the full `pnpm verify` over the integrated changes;
do not substitute partial test runs. Installed projects refresh through an
exact-approved `configure-project` plan, not a default bootstrap overwrite.
Pending marker and exact plan metadata are stored atomically before file
replacement. Old MCP/dashboard sessions reject mutations after an organization
change and need restarting; preference-only read refresh stays available.

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

Database migration 15 marks the coding-host and exact-replay slice; older known
schemas receive an automatic SQLite snapshot before migration. File transactions
remain journaled under `.chartermesh/.transactions`; no-write commands report
them without mutation. Resume the exact approved operation or use explicit
`chartermesh recover` rather than deleting journal or backup files. Revert
future source changes with a new commit; do not delete user files or rewrite
Git history when rolling back.
