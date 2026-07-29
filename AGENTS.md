# Repository guidance

## Applying CharterMesh

- When a user provides this repository and asks to apply CharterMesh to another
  project, read `BOOTSTRAP.md` before taking action.
- Use the repository CLI for planning and applying. Do not imitate its file
  changes manually.
- A general request to apply CharterMesh authorizes read-only inspection and
  plan generation, not the resulting writes. Show the exact plan hash and wait
  for a human to approve that hash before applying it.

## Source of truth

- `docs/PRODUCT-DESIGN.md` is the product and architecture source of truth.
- `schemas/orgspec-v1alpha1.schema.json` is the machine-readable contract.
- ADRs record decisions; update an ADR instead of silently changing a boundary.
- The Control Plane database will own mutable runtime state. Do not create a
  second writable task ledger in Markdown, provider chats, or provider-native
  shared task lists.

## Safety

- Preserve user files and unrelated changes.
- Do not copy private data, prompts, logs, databases, credentials, or absolute
  paths from another project.
- Do not deploy, publish, create cloud resources, connect accounts, or install
  packages without explicit user approval.
- Human approval requirements cannot be satisfied by a model reviewer, a host
  permission prompt, or inherited subagent permissions.
- Provider-specific features must enter through capability manifests and
  adapters, not the core schema.

## Collaboration

- Keep the primary agent responsible for requirements, decisions, integration,
  and the final verification report.
- When the user requests delegation, or a later task has multiple independent
  read-heavy tracks, use bounded subagents for exploration, documentation
  checks, tests, or review and return distilled findings.
- Avoid parallel write-heavy work in one checkout. Use separate worktrees or
  explicit non-overlapping file ownership before parallel writes.
- Wait for delegated work, reconcile conflicts centrally, and count every child
  model execution in the relevant budget.
- Treat Codex subagents, Claude subagents/agent teams, goals, threads, and native
  schedules as host capabilities. They are not the Organization or WorkItem
  source of truth.

## Development

- Use Node.js 24 or newer and pnpm.
- Prefer dependency-free foundations until a dependency is justified and its
  installation is approved.
- Run `pnpm verify` before declaring a vertical slice complete.
- Tests must be offline and free by default. Real provider tests are opt-in.
- Keep imports explicit with `.ts` extensions so Node can execute erasable
  TypeScript directly during the dependency-free bootstrap.
