# ADR 0022: coding-agent hosts remain adapters over the Control Plane

Status: accepted

## Context

Users want to give a fresh project and the CharterMesh GitHub URL to Codex or
Claude Code, receive a project-aware team, and continue working without
duplicating task state in provider chats. Native host roles, sessions, tools,
and permission prompts are useful, but they do not have the same identity,
approval, durability, or evidence contract as CharterMesh WorkItems.

## Decision

1. `kickoff` binds a project brief, generated files, acceptance criteria, and
   the initial WorkItem to one exact human-approved plan hash.
2. Coding hosts receive deterministic project projections. Codex receives
   `.codex/agents`, `.codex/config.toml`, and an `AGENTS.md` section; Claude
   receives `.claude/agents`, `.mcp.json`, and a `CLAUDE.md` section. These are
   derived host configuration, never a second writable work ledger.
3. Both hosts use a local stdio MCP bridge backed by the same Control Plane.
   Every bridge process receives a fresh non-human session actor. Mutations are
   capability-fenced by the exact WorkItem, Run, Attempt, lease, and generation
   tuple as well as that actor. The bridge cannot approve plans, artifacts,
   tool calls, or user-input decisions and cannot impersonate a human actor.
   One project bridge currently aggregates its allowed OrgSpec role set;
   generated profiles must claim only their own `ownerRole`, but native
   subagent identity and cross-role separation are procedural rather than
   authenticated at that shared endpoint.
4. Direct AgentHost execution records a model invocation before starting the
   provider, then binds CharterMesh WorkItem/Run/Attempt ids to provider
   session and run ids. Lease recovery abandons both records together.
5. Executables and capability snapshots are SHA-256 pinned by the approved
   host plan and the executable is re-attested at apply and execution time.
6. Provider-native approval requests do not satisfy CharterMesh approval. The
   initial Codex app-server adapter rejects them fail-closed and records a
   visible failure until a future exact request/resolve callback is added.
7. This slice enables direct Codex app-server runs. Claude Code receives the
   shared role/instruction/MCP integration, but direct run activation remains
   disabled until a separately tested AgentHost adapter exists.
8. The expanded discover/resume/events/result/cancel contract is advertised as
   AgentHost contract `v1alpha2`; it is not presented as wire-compatible with
   the earlier minimal `v1alpha1` interface.
9. Projected role profiles disable provider-native write and shell tools by
   default, but a parent host policy may override those child settings. This is
   a procedural profile, not an authorization boundary. Governed mutations use
   a bounded content-addressed change set whose paths, before-state hashes,
   bytes, and after-state hashes are stored before one exact human approval. A
   new fenced claim applies only those stored bytes through a recoverable file
   transaction and records durable evidence.
10. The `human:*` actor rule is a local policy boundary, not cryptographic
    proof of a person against a process that can invoke the CLI or modify the
    database. Approval credentials must stay in a separately controlled human
    session.

## Consequences

- A new project can be initialized and connected without copying CharterMesh
  source or teaching the host a provider-specific imitation prompt.
- Codex and Claude can share authoritative work state through MCP while their
  own subagents remain capability profiles. Only Control Plane/MCP mutations
  are cryptographically and transactionally fenced; parent host permissions
  remain outside that boundary.
- Restarting a bridge creates a different actor. An old in-flight lease stays
  owned by the old session until it is expired or explicitly recovered; the
  replacement session cannot reuse its fence.
- Direct Codex runs are intentionally conservative: a role whose workspace
  writes require Control Plane approval is started read-only, because native
  permission prompts cannot yet be resumed through an exact CharterMesh
  approval.
- Direct activation also requires an exact-plan acknowledgement that Codex's
  read-only sandbox does not confine reads to the project directory. This is
  not treated as an external OS sandbox.
- Provider subscriptions, quota, and model cost remain user-owned and may be
  reported as unknown. Offline tests use fake app-server processes and do not
  consume model calls.
