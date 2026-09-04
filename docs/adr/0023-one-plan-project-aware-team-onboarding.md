# ADR 0023: project-type-aware team onboarding is one exact approved projection

Status: accepted

## Context

The original bootstrap proposal inferred only repository languages and risk
signals. A project brief was stored with the first WorkItem but did not shape
the Organization. The ordinary profile could therefore create one generic
operator even when a user had already described a software, research, content,
data, or operations project. Connecting Codex or Claude also required a second
host plan, which made the advertised fresh-project flow easy for a coding host
to stop halfway through.

Users need one understandable setup result: roles, work allocation, operating
rules, copy/paste handoffs, human approval boundaries, and the first WorkItem.
This must remain deterministic and reviewable rather than allowing arbitrary
free text to silently become authority.

## Decision

1. Team composition uses an explicit provider-neutral `--team-template`:
   `general`, `software-product`, `research`, `content-production`,
   `data-analysis`, or `operations`. `--profile` independently controls role
   separation: lean uses an operator, balanced adds a coordinator, and
   controlled adds an independent verifier.
2. `kickoff` defaults to the sanitized `general` template when a host does not
   select one. `propose` and `bootstrap` retain their legacy no-template shape
   unless the option is explicit.
3. A kickoff plan includes machine-readable team design, OrgSpec roles and
   stages, `.chartermesh/TEAM-CHARTER.md`, the immutable brief, acceptance
   criteria, and the initial WorkItem. The charter contains stable role IDs,
   work rules, copy/paste handoff packets, and an exact-hash human approval
   matrix. It stores no raw brief or personal data.
4. The bundled `organization-bootstrap` skill maps a user's project goal to an
   explicit template and defensible profile, then invokes the CLI. The model's
   interpretation selects an option; the CLI does not infer organizational
   authority from free-form wording.
5. `kickoff --host codex|claude` may include project-role and MCP projection in
   the same plan hash. The host executable and capability snapshot are pinned
   and re-attested at apply. Codex retains its explicit unrestricted-read
   acknowledgement. A new host session is still required after apply.
6. The initial owner role and execution target must exist and be enabled in
   the exact generated Organization. Invalid overrides fail before writes.
7. OrgSpec stages and the team charter are allocation contracts, not proof of
   automatic agent execution. Kickoff creates one entry-role WorkItem; other
   declared roles are bounded copy/paste consultations unless the Control
   Plane separately assigns them their own WorkItem. Host projection does not
   automatically bind stages or transfer ownership. The Control Plane remains
   the only mutable WorkItem and approval ledger.
8. The existing separate `configure-host` operation remains available for an
   installed project, direct Codex activation, or later host changes.

## Consequences

- A coding host can turn one project brief into a visible team and optionally
  its native project roles with one exact human approval instead of two.
- An omitted project classification still produces a usable general kickoff
  team, while an explicit template produces deterministic domain language and
  distinct proposal hashes.
- This is project-type-aware scaffolding, not bespoke role generation from the
  full brief. Projects with the same template and profile intentionally share
  the same role/stage shape.
- No provider account, paid model call, deployment, or external package is
  started by team design. `fake` remains the offline default.
- Copy/paste handoffs reduce human reconstruction work but do not authenticate
  native subagent identity or automate workflow progression.
- Existing bootstrap callers that omit `--team-template` preserve their
  proposal and Organization structure.
