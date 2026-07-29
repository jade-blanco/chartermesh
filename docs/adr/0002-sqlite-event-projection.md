# ADR 0002: SQLite ledger and event projections

- Status: accepted in design; implementation pending
- Date: 2026-07-27

## Decision

Use SQLite in WAL mode as the single-user runtime ledger behind repository
interfaces. Mutations update current projections and append versioned events in
one transaction, or use a transactional outbox when a boundary prevents one
transaction.

## Invariants

- Idempotency keys are unique within their mutation scope.
- Event sequence is monotonic and events are append-only.
- Reads and no-change synchronization do not create events.
- Terminal records are not rewritten; follow-up work creates new records.
- Migration down steps must preserve user-owned files and document any
  irreversible data transform.
