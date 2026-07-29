# ADR 0008: Separate model engines from agent hosts

- Status: accepted
- Date: 2026-07-27

## Context

The original `ProviderProfile` combined three different concerns:

1. an LLM inference API,
2. an external agent product with sessions and tools,
3. a product-owned runner that can drive an arbitrary model.

That shape made Codex and Claude Code appear to be architectural dependencies
and made capabilities such as structured output, worktree isolation, or native
schedules ambiguous.

## Decision

Use four explicit concepts:

- `ModelEngine`: pure inference (`generate`, usage, cancellation). It does not
  own WorkItems, tools, workspaces, approvals, schedules, or the task ledger.
- `ManagedRunner`: the product-owned agent loop. It accepts an injectable
  `ModelEngine` and owns tool execution, workspace access, approval
  pause/resume, retries, and Control Plane integration.
- `AgentHost`: an external agent runtime whose model selection is host-managed.
  Codex, Claude Code, and similar products enter here through optional adapters.
- `ExecutionTarget`: a role-selectable reference to either a managed runner or
  an agent host. A role never selects a raw model engine.

Capabilities use separate namespaces:

- `model.*` for inference features,
- `runner.*` for product-owned loop features,
- `host.*` for agent-runtime/session/collaboration features,
- `schedule.*` for native automation,
- `integration.*` for packaging and protocol surfaces.

OrgSpec stores desired profiles and references. Adapter discovery returns
runtime manifests. The compiler validates preferred and fallback targets
against both model and host requirements and binds the discovered capability
snapshot into the InstallPlan hash.

A text-generation-only model may participate when the selected role only needs
that contract. Structured output or tool calling may be emulated only when the
plan marks the binding degraded and the user explicitly opts in. Unsupported
features never silently downgrade.

## Consequences

- The baseline implementation and E2E use a fake/generic model engine plus the
  built-in managed runner.
- Codex and Claude Code are compatibility adapters, not MVP dependencies.
- A host-managed agent runtime cannot accept an injected engine.
- Model calls inside one agent Attempt are recorded as `ModelInvocation`
  records, allowing a multi-step tool loop without conflating a model call with
  the whole Attempt.
- Adding an LLM normally requires only a `ModelEngine` adapter and capability
  manifest; it does not require changes to OrgSpec core types.
