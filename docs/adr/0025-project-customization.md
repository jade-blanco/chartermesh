# ADR 0025: exact-approved project preferences and organization customization

Status: accepted

## Context

Template-based kickoff supplies a stable starting team, but projects need
different instructions, document styles, responsibilities, and workflows as
their needs become clearer. Reapplying bootstrap would risk replacing those
choices with defaults. Free-form instructions must not silently change tools,
approval policy, connections, or the authoritative work ledger.

## Decision

1. `project-config --target PATH --json` reads the current organization,
   effective preferences, and customization marker. `configure-project`
   previews a deterministic no-write plan and applies only after a human
   approves its exact hash using the same options plus `--approve HASH`.
2. Optional `--preferences-file` supplies the complete
   `chartermesh.dev/project-preferences/v1alpha1` contract: `apiVersion`,
   `language` (`auto|ko|en`), `approvalDetail` (`eli5|concise|technical`),
   `tone` (`plain|formal`), `projectInstructions`, and `roleInstructions` keyed
   by valid role IDs. Defaults are auto, eli5, plain, and empty instructions.
3. `.chartermesh/preferences.json` stores approved project guidance;
   `PREFERENCES.md` and other managed instructions are projections. Preferences
   are advisory, not an OrgSpec extension, permission grant, model training
   record, or mutable WorkItem ledger. Explicit approved presentation choices
   refine the ELI5 default in ADR 0024 without removing hashes, risks, unknowns,
   evidence distinctions, or human approval requirements.
4. Optional `--organization-file` supplies a complete validated OrgSpec with
   the same `metadata.id` and exactly the next revision. It may revise roles,
   responsibilities, workflow dependencies, and allowed tools but cannot weaken
   the current approval policy. Existing execution-target, capability, and
   orchestration configuration is reused; connection and schedule changes
   retain their separate configuration paths.
   Schedules in any state protect their referenced role/workflow definitions
   from structural changes; display-name changes remain possible. Team-design
   projections use source `approved_custom_orgspec` and the current approved
   roles/workflows rather than stale template claims.
5. Active runs or `in_progress` WorkItems block customization. Remaining
   unfinished work must retain valid role and execution-target references.
   Relevant work state is hashed into the plan and rechecked at apply, so
   approval cannot silently cover a changed allocation context.
6. Updating an existing native projection supports exactly one installed Codex
   or Claude host selected by `--host`, with executable re-attestation through
   `--executable-sha256`. Codex additionally requires
   `--allow-unrestricted-read`. Multiple hosts fail closed. Removed role files
   become retired notices, and a new host session plus MCP health check is
   required after apply. The shared host bridge does not authenticate native
   subagent identity or become an approval authority.
   Organization candidates with native roles require this refresh;
   preferences-only changes may update shared guidance without regenerating
   native files when `--host` is omitted.
7. Omitted candidates preserve their current settings; a command with neither
   candidate previews a managed-document refresh. Applied customization leaves
   an overwrite-protection marker so ordinary bootstrap cannot replace the
   tailored project. Bootstrap/kickoff and connection configuration preserve
   saved preferences subject to that protection.
8. Before file replacement, commit the pending customization marker and exact
   approved plan together in Control Plane metadata. Keep work mutations
   blocked across interruption until that plan resumes. Recovery uses the
   stored approved plan rather than reconstructing authority from an input
   file that may have disappeared or changed.
9. MCP and dashboard mutation paths reject a changed organization relative to
   their loaded policy snapshot and require a new session. Read-only inspection
   remains available; preference-only reads do not require replacing the
   organization policy snapshot.
10. A no-candidate approved refresh updates installation version pins and
    managed command references while preserving the current organization,
    preferences, and unrelated user-written guide text. It is not a
    rebootstrap or a reset to template defaults.

## Consequences

- A coordinating team may freely propose a better project setup, while the
  person retains the final exact-hash decision. Proposals are not autonomous
  self-modification or authorization to run additional work.
- Prompt guidance can request language, tone, and detail; it does not guarantee
  natural-language quality or translate immutable historical artifacts.
- Decision Packet presentation honors language/detail settings without
  changing packet identity. Auto selects CLI English and dashboard Korean.
  Bootstrap/configuration/evaluation plan explanations remain English ELI5;
  tone/free-form instructions do not rewrite every fixed UI string.
- Existing schemas, evidence status, and the Control Plane remain the sources
  of truth for authority and runtime state. No second writable task ledger is
  introduced.
- Project-file changes use the existing reviewed apply and recovery boundary.
  A completed customization is changed again through a new plan, not by
  deleting its marker or resetting the organization to a template.
- The `v0.0.10-alpha.1` package includes this flow without requiring a manual
  source checkout. Host-bound setup still needs the exact approved plan and
  new-session MCP health verification.
