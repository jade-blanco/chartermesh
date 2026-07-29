# Handover

## Current state

- Product design is in `docs/PRODUCT-DESIGN.md` with native collaboration,
  engine/host separation, universal bootstrap, Control Plane, and action
  projection boundaries.
- Phase 0, OrgSpec, and a dependency-free runnable local vertical slice are
  present.
- `ModelEngine`, `AgentHost`, and `ManagedRunner` are separate contracts;
  generic and fake engines are the primary foundation, while Codex and Claude
  Code remain optional host adapters.
- No package publication, provider login, paid call, deployment, or cloud
  resource is required.
- Apache-2.0 is selected and the standard license text is in `LICENSE`.

## Verify

```powershell
pnpm verify
git status --short
```

## Implemented local path

1. Agent-readable exact-hash bootstrap protocol.
2. SQLite Control Plane and action projection.
3. Fake and OpenAI-compatible model engines.
4. Built-in single-turn managed runner.
5. CLI lifecycle and responsive loopback dashboard.

## Next implementation slice

1. Add versioned SQL migrations and transactional outbox.
2. Add heartbeat, lease expiry, retry, and crash recovery.
3. Add result-review controls to the dashboard.
4. Add a second protocol-native ModelEngine adapter.
5. Add optional AgentHost adapters without changing the core ledger.

## Rollback

There is no database migration or provider installation in this slice. Revert
future changes with a new commit; do not delete user files or rewrite Git
history when rolling back.
