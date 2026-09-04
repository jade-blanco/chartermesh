# Project-type-aware team scaffolding

CharterMesh's organization bootstrap is intended to turn a project goal into
one reviewable setup operation. The setup covers:

- the initial team and role boundaries;
- ownership of each stage of work;
- operating and handoff rules;
- the decisions that require a person;
- the first WorkItem and its acceptance criteria;
- optional projection into a supported coding host.

The current implementation is deliberately template-aware rather than a
bespoke organization generator. The coding host interprets the goal and
selects one of six reviewed templates; projects in the same template and
profile receive the same stable role IDs and stage shape. The goal itself is
still bound into the brief, acceptance contract, title, and initial WorkItem.
Custom role graphs are not inferred by this scaffold. For an installed project,
the `configure-project --organization-file` path accepts a
separately reviewed, validated complete OrgSpec revision; see
[Project customization](PROJECT-CUSTOMIZATION.md).

"One setup" means one deterministic no-write plan and one CharterMesh approval
of its exact hash. It does not mean silently changing a project as soon as a URL
or a brief is supplied. Codex project trust or Claude's one-time MCP permission
may still be a separate host UI action; neither approves the CharterMesh plan.

## Two explicit choices

Team composition uses two independent controls. Keeping these controls
explicit prevents a model's wording preferences from silently changing the
approved organization.

### Team template

`--team-template` selects the kind of work:

| Template | Use when the primary work is |
| --- | --- |
| `general` | mixed, exploratory, or not yet classifiable |
| `software-product` | an application, service, library, integration, or automation |
| `research` | evidence gathering, source comparison, analysis, and synthesis |
| `content-production` | documents, presentations, media, campaigns, or publications |
| `data-analysis` | datasets, metrics, statistical or model analysis, and reporting |
| `operations` | repeatable operational procedures, monitoring, and controls |

The template gives roles and stages domain-relevant responsibilities while
keeping stable provider-neutral role identifiers. It does not select an LLM
vendor.

### Operating profile

`--profile` selects how much role separation the project needs:

| Profile | Typical structure | Trade-off |
| --- | --- | --- |
| `lean` | one domain operator | smallest setup; review remains primarily human |
| `balanced` | coordinator plus domain operator | clear intent and execution ownership without a separate verifier |
| `controlled` | coordinator, domain operator, and verifier | independent verification at the cost of another stage |

Use `balanced` as the ordinary default. Use `controlled` when errors are hard
to reverse, evidence quality matters, or implementation should not verify
itself. Use `lean` only when the reduced separation is deliberate.

If two or more choices would materially change authority, cost, or safety, the
bootstrap agent may present concise alternatives. If the brief clearly implies
one structure, it should select that defensible default and proceed to a
no-write preview rather than asking a long series of setup questions.

## One-plan kickoff

For a new or empty project, place the goal and constraints in a brief outside
the target, then preview the complete operation:

```text
chartermesh kickoff --target TARGET --brief-file BRIEF_FILE \
  --team-template software-product --profile controlled \
  --engine fake --json
```

This command is read-only. Its response should make the following visible
before approval:

1. the selected template and rationale;
2. every role and its responsibilities;
3. stage-by-stage work ownership;
4. copy/paste handoff packets;
5. human approval boundaries;
6. the initial WorkItem and acceptance criteria;
7. every proposed file and its before/after hash;
8. one deterministic plan hash.

When the user also wants a supported coding host, include the corresponding
host option in the same kickoff preview. Codex requires the explicit
unrestricted-read acknowledgement used by its read-only host adapter:

```text
chartermesh kickoff --target TARGET --brief-file BRIEF_FILE \
  --team-template software-product --profile controlled \
  --engine fake --host codex --executable-sha256 HOST_SHA256 \
  --allow-unrestricted-read --json
```

Use `--host claude` for Claude projection. Omit `--host` when only the core
organization is wanted. Host projection is optional; when selected, it requires
a new host session and MCP health check after apply. It never changes which
system owns WorkItems or human decisions.

After review, a person approves the exact hash. Repeat every option unchanged
and append:

```text
--approve PLAN_HASH
```

Any changed file, brief, option, executable, or capability produces a new
plan. The prior approval must not be reused.

## Generated team charter

The kickoff plan writes a human-readable `.chartermesh/TEAM-CHARTER.md`
projection alongside the machine-readable organization. It should contain:

- role purpose, responsibilities, and non-responsibilities;
- stage allocation and completion expectations;
- shared work rules and evidence requirements;
- a copy/paste handoff format;
- a copy/paste human approval request format;
- a concise approval matrix;
- the boundary between core records and host capabilities.

The charter is an operating guide, not a second writable task ledger. WorkItem
state, attempts, artifacts, decisions, and approval receipts remain in the
SQLite Control Plane.

Kickoff creates one initial WorkItem for the entry `operator`. Coordinator and
verifier stages are explicit copy/paste consultations in this release, not
separate automatically claimable WorkItems. A projected consulting role may
read the bounded handoff context and return a packet, but it must not claim or
mutate another role's WorkItem. A separately assigned WorkItem is required for
role-owned Control Plane mutation.

### Copy/paste handoff

Each handoff should carry enough context for the receiver without reproducing
the whole conversation:

```text
[CharterMesh handoff]
From: coordinator
To: operator
WorkItem: WORK_ITEM_ID
Objective: one bounded outcome
Inputs: approved brief and referenced artifacts
Decisions: decisions already made and their constraints
Deliverables: expected outputs
Evidence: checks or sources required
Open risks: unresolved issues, or none
Requested action: implement, verify, revise, or return for decision
```

The sender does not mark the receiving stage complete. The receiver checks the
packet against its role boundary and may return it when required context,
authority, or evidence is missing.

### Human approval request

Every human approval document defaults to ELI5: understandable to a
non-specialist adult, not childish. Use the user's language, explain necessary
technical terms, and put the decision and consequences before technical
details. The request should identify the exact decision rather than ask for a
broad "go ahead":

```text
[CharterMesh approval request]
What and why: the proposed action and its purpose in everyday language
If you approve: what changes, and what this does not authorize
Who or what is affected: the bounded files, people, or systems
Risks, cost, and unknowns: known consequences; say when not yet known
Recovery and limits: what can be restored, what cannot, or not yet checked
Your choices: approve this exact request, reject, or ask for a revised plan

[Exact details — keep identifiers and evidence unchanged]
WorkItem: WORK_ITEM_ID
Decision: the exact proposed action
Reason: why a human decision is required
Scope: files, system, account, or external target affected
Evidence: immutable artifact or plan hashes
Evidence status: author claims, verified checks, and checks not yet performed
Requested response: approve or reject the exact referenced hash
```

Use only choices the actual operation supports. Requesting a revision is not
approval; changed plans and artifacts need their new exact review identifiers.
Unknown cost is not zero, and file recovery does not imply that publication or
other external effects can be undone. Keep original source text intact beside
the explanation. Templates and host instructions guide writing but do not
validate natural-language quality or translate an author's existing report.

Approved project preferences may select concise or technical detail and a
different language or tone instead of the default. Those choices change
presentation, not the required evidence, risk disclosure, or exact approval.

Organization changes, deployment or publication, external side effects,
destructive actions, account or credential changes, and policy-marked tool
calls require human approval. A C-level model, verifier model, subagent, or
host permission dialog cannot substitute for it.

## Sanitized example

Suppose the brief asks for a local inventory reminder tool with an import
screen, reminder rules, and offline tests. A defensible setup is:

- template: `software-product`;
- profile: `controlled`;
- coordinator: clarifies the product boundary and acceptance criteria;
- operator: implements the bounded product slice and records test evidence;
- verifier: checks behavior against the approved acceptance criteria and
  returns defects without rewriting the goal.

The coordinator hands the approved slice to the operator using the packet
above. The operator hands implementation evidence to the verifier. Publishing
the tool, connecting an account, or changing the organization still returns
to the person for an exact approval. No real project name, customer data,
credential, or private prompt needs to be embedded in the reusable template.

A plain-language setup request could begin: "This creates the listed team
setup files and one first task for your inventory reminder tool. You approve
only this setup, not publishing the tool or using a paid model. If you want a
different team, ask for a revised plan before applying. The preview below shows
which files would change; whether those changes can be restored must be
checked separately." The actual request still includes the exact preview and
plan hash, and reports any real risk or cost it discovers.

## Improve the team after setup

The coordinator may propose clearer role instructions, responsibilities, or
workflow dependencies based on the project's needs. Read `project-config`,
prepare preferences and, when needed, a complete OrgSpec candidate, and preview
them with `configure-project`. A person approves the exact hash before apply.
The current approval policy cannot be weakened, existing execution/capability/
orchestration settings are reused, and connections remain separate.

Active execution blocks customization. Other unfinished work must retain valid
owners and execution targets; a changed work state requires a new plan.
Updating native roles additionally requires a single existing Codex or Claude
projection, host re-attestation, and a fresh session. Added stages do not
automatically create WorkItems or prove that delegation occurred.

Saved `.chartermesh/preferences.json` and its `PREFERENCES.md` projection carry
project/role guidance and presentation choices. They do not grant authority or
replace the Control Plane. Applied customization is protected against a later
default bootstrap overwrite; further changes need a new reviewed plan. This is
human-directed configuration, not automatic self-reorganization or model training.

## What the setup does not claim

- A declared team is not proof that a host automatically created or called
  subagents.
- A copy/paste handoff is a readable projection, not the mutable WorkItem
  source of truth.
- Codex, Claude, or another host may provide delegation, parallelism, or MCP
  transport, but those features are capability adapters around the approved
  organization.
- Bootstrap does not start a paid model call, install an external provider, or
  grant an agent human approval authority.

After host projection is applied, open a new session from the target root and
verify status and next-work discovery before assigning implementation. If the
host cannot supply a requested capability, keep the approved organization and
use an explicit manual or copy/paste handoff rather than inventing a second
ledger.
