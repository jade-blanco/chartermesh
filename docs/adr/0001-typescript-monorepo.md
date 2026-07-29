# ADR 0001: TypeScript monorepo foundation

- Status: accepted for bootstrap
- Date: 2026-07-27

## Decision

Use a pnpm workspace with erasable TypeScript, Node.js 24+, and explicit package
boundaries. The current vertical slice uses only Node built-ins so it can be
verified without downloading packages. React/Vite, SQLite bindings, JSON Schema
and YAML libraries remain later dependency decisions.

## Consequences

- Core types can be shared by daemon, CLI, MCP, dashboard, and adapters.
- Bootstrap tests are offline and deterministic.
- Node's type stripping executes tests but does not type-check them; a pinned
  TypeScript compiler must be added after dependency approval.
- Package APIs must avoid TypeScript features that require code generation.
