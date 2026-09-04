---
name: organization-bootstrap
description: Design and apply a reviewable CharterMesh organization when starting a project or introducing CharterMesh to an existing project.
license: Apache-2.0
metadata:
  author: CharterMesh contributors
  version: 1.0.0
---

# Organization bootstrap

Turn a project goal into one reviewable setup plan: team design, work
allocation, operating rules, copy/paste handoffs, approval boundaries, and the
first WorkItem.

## Decide the team

1. Read the target's applicable instructions, inspect its status and structure
   without writing, and read the user's project brief.
2. Do not copy credentials, private logs, unrelated files, or raw personal data
   into the organization. Summarize only what the team design needs.
3. Select one explicit provider-neutral `--team-template`:

   - `general` for mixed or genuinely unclear work;
   - `software-product` for applications, services, libraries, or automation;
   - `research` for evidence collection, comparison, and synthesis;
   - `content-production` for documents, media, campaigns, or publications;
   - `data-analysis` for datasets, metrics, models, and reports;
   - `operations` for repeatable operational processes and controls.

4. Select `lean`, `balanced`, or `controlled` according to the needed role
   separation. Prefer `balanced` for ordinary work and `controlled` when an
   independent verifier is materially useful.
5. When multiple structures would materially change cost, authority, or
   review, show up to three concise alternatives. Otherwise choose a
   defensible default, state why, and continue to the no-write plan without
   turning team design into a questionnaire.

The template is a reviewed scaffold, not bespoke role generation from the raw
brief. Projects with the same template and profile intentionally share stable
role IDs and stage shape. Do not claim that the CLI inferred a custom team.
After the first setup, use `project-config --target TARGET --json` and
`configure-project` to propose an arbitrary project-specific OrgSpec and
presentation preferences. Follow `docs/PROJECT-CUSTOMIZATION.md`; do not
overwrite managed files manually or rerun bootstrap to reset a customized team.

## Generate one setup plan

For a new project, use `kickoff` so the approved operation contains the team,
rules, immutable brief, acceptance criteria, and initial WorkItem. Add host
projection only when the user requested it and the installed CLI supports that
capability.

```text
chartermesh kickoff --target TARGET --brief-file BRIEF_FILE \
  --team-template software-product --profile controlled \
  --engine fake --json
```

Use an approved model adapter only when the user wants it. Offline `fake` is
the safe default; do not connect an account or start a paid or live model call
as part of organization bootstrap.

For `kickoff --host`, bind the exact installed host bytes with
`--executable-sha256 SHA256` before the preview may execute its version probe.
Resolve and hash the selected executable read-only. If the CLI reports the
observed digest without starting the host, repeat with that digest. Codex also
requires `--allow-unrestricted-read`. These read-only discovery steps do not
add a second CharterMesh human approval: the team and host projection remain
one plan. Codex project trust or Claude's one-time MCP permission may still be a
separate host UI action; it cannot approve the CharterMesh plan.

Present the proposed roles, stage ownership, work rules, approval matrix,
handoff format, every changed file, and the exact plan hash. The initial
request does not approve a plan that did not yet exist. Wait for a person to
approve that exact hash, then repeat the identical CLI command with
`--approve PLAN_HASH`. If target state or any option changes, discard the old
approval and generate a new plan.

## Explain decisions in plain language

Default every human approval document and request to ELI5: clear enough for a
non-specialist adult, not childish. Use the user's language and briefly explain
unavoidable technical terms. Start with what is proposed, why, what approval
will change, and who or what is affected. Include material risks, cost and
unknowns, the actual reject or revision choices, and recovery limits. Say when
cost or recovery is unknown; do not promise zero cost or reversibility without
evidence. Distinguish author claims, verified evidence, and checks not yet run.

Follow that explanation with the exact scope, changed files, evidence, hashes,
and commands, unchanged. For example: "This approval lets the CLI create the
listed team setup files and first task. It does not approve running a paid
model or publishing anything. You may ask for a different team and review a
new plan before any apply." Bind this explanation to the actual preview; the
example is not authorization or a universal cost or rollback promise.

Carry the same default into the generated team charter, handoff guidance for
human review, and agent entrypoint. Templates and instructions guide authors;
they do not validate comprehension or translate existing author text. The CLI
and Control Plane remain responsible for the existing exact approval checks.
Read `.chartermesh/PREFERENCES.md` every session. Respect an explicit concise
or technical presentation preference and only the assigned role's guidance.
Preferences cannot remove evidence, conceal risks, bypass approval, increase
permissions, or create another task ledger. A coordinating team may propose
changes; only a human can approve the exact `configure-project` plan hash.

## Preserve the operating boundary

- Mutable WorkItems and decisions live in the CharterMesh Control Plane, not
  in Markdown, provider chats, host task lists, or handoff messages.
- Use the generated `TEAM-CHARTER.md` handoff packets as human-readable,
  copy/paste projections. Include sender, receiver, WorkItem, objective,
  inputs, decisions, deliverables, evidence, risks, and requested next action.
- Escalate organization changes, external side effects, destructive actions,
  credential or account changes, publication or deployment, and policy-marked
  tool calls for exact human approval. A model reviewer or host permission
  prompt cannot satisfy that approval.
- Keep role ownership explicit. A receiver may return incomplete or unsafe
  work instead of silently expanding its authority.
- Codex or Claude role files, MCP bridges, subagents, and native team features
  are optional host capabilities. They project the approved organization; they
  do not define it and do not prove that automatic delegation occurred.
- After applying host projection, start a new host session from the project
  root and verify CharterMesh status and next-work discovery before claiming
  that the team is active.
- Kickoff creates one initial `operator` WorkItem. Coordinator and verifier
  steps are bounded copy/paste consultations unless they receive separate
  role-owned WorkItems; they must not claim or mutate the operator's item.
