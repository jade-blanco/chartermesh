# ADR 0010: Tailored proposals and structured engine execution

- Status: accepted
- Date: 2026-07-29

## Context

A static organization template does not satisfy the one-sentence application
goal: a coding agent needs a deterministic way to inspect a target, explain an
appropriate operating profile, and produce a plan that another host or CLI can
consume. Small/local models also need a narrower, machine-checkable result
contract than unconstrained prose.

## Decision

The CLI performs a metadata-only target assessment and emits a versioned,
hash-bound proposal for lean, balanced, or controlled operation. Bootstrap
persists the proposal, desired OrgSpec, runtime binding, and installation
provenance only after approval of the exact plan hash.

Agent-facing commands use `chartermesh.dev/cli/v1alpha1` JSON envelopes.

The built-in ManagedRunner requires
`chartermesh.dev/structured-artifact/v1alpha1`, validates output locally,
allows one repair turn, and propagates cancellation. Model-native JSON Schema
and tool calling are adapter capabilities. Native support is never assumed.

The Control Plane enforces installed concurrent-run, daily-start, and
monthly-cost budgets at claim time. Failed and expired runs become visible and
retryable with a new fenced generation.

## Consequences

- Codex, Claude Code, another coding agent, a human, or a script follows the
  same proposal and approval contract.
- A smaller model can be evaluated within the same bounded workflow without
  becoming the ledger or approval authority.
- Target assessment remains deterministic and avoids reading project content.
- The first evaluator is synthetic and intentionally does not claim general
  model quality.
- A general tool-execution loop and crash-after-process-death apply recovery
  remain separate hardening work.
