# ADR 0024: plain-language-first human approval documents

Status: accepted

## Context

Exact hashes and evidence bindings prevent approval of the wrong subject, but
they do not explain a decision to someone unfamiliar with the system. Approval
documents must support informed human judgment without weakening those checks.

## Decision

1. ELI5 is the default for every human approval document: plain language for a
   non-specialist adult, never baby talk. Use the user's language, falling back
   to the task's primary language, and briefly explain necessary technical terms.
2. Lead with what is proposed and why, the actual effect and scope of approval,
   material risks, cost and unknowns, the actual reject or revision choices,
   and recovery limits. Follow with exact identifiers, scope, hashes, commands,
   evidence, and preserved original source text.
3. Plain language must not upgrade `claimed` to `verified`, erase missing
   checks, turn unknown cost into zero, or promise unverified rollback. Artifact
   acceptance must not be described as authorization for external execution.
4. Apply the guidance to setup/configuration/recovery plans, review artifacts,
   tool approval and input requests, generated team charters and agent
   entrypoints, projected host instructions, and the built-in runner prompt.
5. UI explanations remain deterministic, model-free projections of existing
   records. They supplement rather than replace the exact artifact, producer
   report, evidence and approval bindings. They do not translate authored text
   or enforce its natural-language quality or comprehension.

## Consequences

- Review starts with the decision's meaning while exact technical inspection
  remains available. Authors must identify uncertainty instead of inventing
  reassuring cost, verification, or recovery claims.
- Prompt and template guidance can improve writing but cannot guarantee that
  arbitrary model output meets the standard. Tests verify guidance propagation
  and preserved approval/evidence boundaries, not human comprehension.
- No OrgSpec or Decision Packet schema, permission, approval policy, state
  transition, or mutable ledger is added or changed.
- Generated file bytes and their plan hashes change. Existing installations
  receive updated guidance only through the usual preview and exact approved
  application; this decision does not authorize silent rewrites.
