# ADR 0005: Native collaboration is an adapter capability

- Status: accepted
- Date: 2026-07-27

## Context

The original design predated several current host capabilities. Codex now
supports native subagent workflows, project custom agents, steering and
interrupting child work, Goal mode, worktrees, and scheduled tasks. Claude Code
supports subagents, background sessions, worktrees, scheduled tasks/routines,
and an experimental agent-team mode with peer messaging and a shared task list.

Recreating those primitives would add cost and conflict with the product's
actual differentiation. Treating them as the product ledger would instead lose
provider neutrality, durable governance, and safe failover.

## Decision

The Control Plane owns organization intent, work identity, approval authority,
budget, audit, and cross-provider state. Provider hosts may orchestrate one
bounded Run using their native collaboration features.

`OrchestrationIntent` expresses `single`, `delegated`, or `peer_team` without
naming a host. Adapters return capability descriptors with stability, surface,
minimum version, permission behavior, isolation, and cost visibility.

## Codex mapping

- Native subagents are suitable for bounded independent work. The parent
  remains responsible for synthesis.
- Child sandbox and permission inheritance is a host boundary, not a product
  human approval.
- Project custom agents compile to `.codex/agents/*.toml` only through an
  approved InstallPlan.
- Parallel writes require isolated worktrees or explicit file ownership.
- Goal and chat scheduling provide continuity but do not replace WorkItem and
  Run state.
- App-server or SDK is preferred for eventful runtime control. Generated
  app-server schemas are pinned to the detected Codex version, and experimental
  methods require opt-in.
- Scheduled-task management is manual when no supported programmatic contract
  is detected.

## Claude Code mapping

- Subagents handle focused delegation.
- Agent teams can satisfy `peer_team` only when the detected version supports
  them, the user opts into the experimental capability, and isolation rules are
  satisfied.
- The agent-team shared task list is an execution detail, never the WorkItem
  ledger.
- Team permission inheritance cannot authorize a product-level side effect.
- Desktop local tasks, hosted routines, and session `/loop` are separate
  capabilities with different availability, approval, and missed-run behavior.

## Evidence checked

Official documentation reviewed on 2026-07-27:

- [Codex subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents)
- [Codex scheduled tasks](https://learn.chatgpt.com/docs/automations)
- [Codex app-server](https://learn.chatgpt.com/docs/app-server)
- [Codex SDK](https://learn.chatgpt.com/docs/codex-sdk)
- [Codex plugin builder](https://developers.openai.com/plugins)
- [Claude Code agents](https://code.claude.com/docs/en/agents)
- [Claude Code agent teams](https://code.claude.com/docs/en/agent-teams)
- [Claude Code Desktop scheduled tasks](https://code.claude.com/docs/en/desktop-scheduled-tasks)
- [Claude Code routines](https://code.claude.com/docs/en/web-scheduled-tasks)
- [Claude Agent SDK permissions](https://code.claude.com/docs/en/agent-sdk/permissions)

Callable features observed in this Codex session include bounded agent spawn,
follow-up, messaging, interruption, waiting, plan updates, goal lifecycle, and
thread/task controls. These are runtime observations, not portable public API
contracts; adapters must still detect support.

## Consequences

- Core state remains stable as provider features evolve.
- Native collaboration can reduce custom runner code.
- Capability drift and experimental features need explicit tests.
- Child executions add token and cost records.
- Some native setup becomes a `UserAction` rather than an automatic apply.
