# ADR 0003: DB-first scheduler, leases, and fencing

- Status: accepted in design; implementation pending
- Date: 2026-07-27

## Decision

The default scheduler queries SQLite before starting a provider session.
Claiming work atomically creates the Run, Attempt, and Lease. Every write from a
worker carries the active generation and fencing token.

Provider-native schedules are external projections. They may start a model
before checking work, so they are degraded unless the provider exposes a
deterministic pre-model launcher. Empty starts must be measured.

## Failure behavior

- Expired leases can be reclaimed with a higher generation.
- A stale generation cannot submit artifacts or terminal events.
- Overlap is denied by default.
- Retry is bounded and ends in a dead-letter state.
- Global, adapter, and schedule pause prevent new claims.
