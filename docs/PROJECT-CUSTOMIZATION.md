# Customize an installed project

CharterMesh can adapt the team's instructions, document style, and organization
to your project. A coordinating agent may propose improvements, but a person
must approve the exact plan before they take effect. This is reviewed project
configuration, not model training, autonomous self-improvement, or permission
for an agent to approve itself.

> This guide describes `v0.0.10-alpha.1`. Use its tag-pinned GitHub package
> without a manual checkout, or a reviewed matching source checkout.
> Host-bound use retains the exact approval and new-session health gates in
> [CODING-HOSTS.md](CODING-HOSTS.md).

## What can change

| Change | Approved path | Boundary |
| --- | --- | --- |
| Language, approval detail, tone, project and role instructions | `configure-project --preferences-file` | Advisory writing guidance; no new tools or approval authority |
| Roles, responsibilities, workflow dependencies, allowed tools | `configure-project --organization-file` | Valid complete OrgSpec; existing approval policy cannot be weakened |
| Model or coding-host connection | `configure-engine` or `configure-host` | Separate connection plan; preferences are preserved |
| Schedules | Existing schedule configuration path | Not a project-customization shortcut |

ELI5 remains the default: clear language for a non-specialist adult, not baby
talk. You may explicitly choose concise or technical explanations. Every style
must retain the actual effect, scope, material risks and unknowns, evidence
status, and exact approval hashes. A style choice never turns `claimed` into
`verified`, unknown cost into zero, or uncertain recovery into a guarantee.

## 1. Inspect the current configuration

Use the same reviewed executable for inspection, preview, and apply:

```powershell
node bin/chartermesh.mjs project-config --target TARGET --json
```

Without a source checkout, replace `node bin/chartermesh.mjs` in each example
with `npx --yes github:jade-blanco/chartermesh#v0.0.10-alpha.1`, keeping the
remaining options unchanged. The package download requires explicit approval.

This reads the current organization, effective preferences, and customization
marker. It does not alter the project. Review these before preparing a candidate;
do not treat an old chat or a handoff document as current configuration.

## 2. Prepare preferences outside the target

Create a complete JSON candidate outside the target project so preparing it does
not alter the installed configuration before approval. For example:

```json
{
  "apiVersion": "chartermesh.dev/project-preferences/v1alpha1",
  "language": "ko",
  "approvalDetail": "eli5",
  "tone": "plain",
  "projectInstructions": "Explain the user-visible result before implementation details.",
  "roleInstructions": {
    "operator": "Report checks actually performed and list remaining checks separately."
  }
}
```

Use only role IDs that exist in the proposed organization; `operator` is an
example, not a universal role. Do not store credentials, private logs, or
unrelated personal information in instructions. They are project guidance
that may be included in generated documents and model or host prompts.
Project and individual role instructions are limited to 4,000 characters each;
at most 50 role entries and a 1 MiB preferences document are accepted. Unknown
fields and unsafe control characters are rejected.

The six fields are:

| Field | Values or meaning | Default |
| --- | --- | --- |
| `apiVersion` | `chartermesh.dev/project-preferences/v1alpha1` | Same identifier |
| `language` | `auto`, `ko`, `en` | `auto` |
| `approvalDetail` | `eli5`, `concise`, `technical` | `eli5` |
| `tone` | `plain`, `formal` | `plain` |
| `projectInstructions` | Project-wide guidance text | Empty string |
| `roleInstructions` | Object mapping existing role IDs to guidance text | Empty object |

For Decision Packet explanations, `auto` currently means English in the CLI
and Korean in the dashboard. Model guidance follows the user's or task's
language when available. Language/detail preferences apply to Decision Packet
views and model guidance; bootstrap, configuration, and evaluation plan
explanations currently remain English ELI5. Tone and free-form instructions
guide models, not translation of every fixed UI label or historical artifact.
Original evidence text and identifiers remain intact.

Decision Packet views use seven explanation sections for ELI5, four compact
sections for concise (still including evidence, risks, and rejection), and
seven sections with technical details initially open for technical. ELI5 keeps
technical details initially collapsed. These are presentation choices; the
exact packet and its approval binding do not change.

## 3. Preview, decide, and apply

```powershell
node bin/chartermesh.mjs configure-project --target TARGET `
  --preferences-file PREFERENCES_FILE --json
```

The preview performs no target writes. Read what changes, why, the actual effect
of approval, affected files, risks and unknowns, and the exact plan hash. To
reject it, do not apply it. To request changes, revise the candidate and obtain
a new preview. Once a person approves the exact hash, repeat every option:

```powershell
node bin/chartermesh.mjs configure-project --target TARGET `
  --preferences-file PREFERENCES_FILE --json --approve PLAN_HASH
node bin/chartermesh.mjs project-config --target TARGET --json
node bin/chartermesh.mjs doctor --target TARGET --json
```

The approved operation writes `.chartermesh/preferences.json` and its readable
`.chartermesh/PREFERENCES.md` projection with the related managed guidance.
The JSON is the saved preference contract; Markdown is a generated guide, not
a second task ledger. WorkItems and decisions still belong to the Control Plane.

Omitting a candidate keeps that part of the current configuration. With neither
candidate, `configure-project --target TARGET --json` previews a refresh of
current settings and managed documents; applying that refresh still requires
its exact hash. A changed candidate, target file, or relevant work state makes
the previous approval unusable.

## Changing the organization

Use the current complete OrgSpec as the starting point. Keep `metadata.id` and
set `metadata.revision` to exactly the current revision plus one. The candidate
must pass schema, reference, and workflow dependency validation.

```powershell
node bin/chartermesh.mjs configure-project --target TARGET `
  --organization-file ORGANIZATION_FILE --preferences-file PREFERENCES_FILE --json
```

The preferences file is optional. Roles, responsibilities, workflow dependency
graphs, and tool allowlists can be proposed within the validated contract.
This path cannot weaken the current approval policy or replace the existing
execution-target, capability, or orchestration configuration. Connections and
schedules stay on their separate paths. It does not create or run new WorkItems
merely because the organization declares another role or stage.

The plan refreshes `team-design.json` from the approved roles and workflows,
with source `approved_custom_orgspec`, rather than presenting a modified team
as an unchanged template. Existing schedules in any state, including proposed
or paused, protect the role/workflow definitions they reference: only display
name changes to those referenced definitions are allowed on this path.

Configuration is blocked while a run is active or a WorkItem is `in_progress`.
Other unfinished WorkItems must retain valid owners and execution targets in
the candidate. Their relevant work-state hash is bound into the preview and
checked again at apply; a changed work state requires a new plan. Do not delete
work or rewrite the database to bypass a rejected plan.
The no-write preview also waits for pending SQLite WAL data to be checkpointed;
close active writers and idle dashboard/host connections and retry if it reports
`PROJECT_CONFIGURATION_BUSY`. It will not silently checkpoint or create database
sidecar files during preview. Pending/retryable work is bounded to 1,000 items
for this operation; larger queues require settling work before reconfiguration.

## Existing Codex or Claude projection

An organization candidate with native roles requires an explicit refresh of
the same host using `--host codex` or `--host claude`. This path supports only
one installed native host. Re-attest its executable in the same plan with
`--executable-sha256 SHA256`. For Codex, also supply
`--allow-unrestricted-read` to acknowledge its host-user read scope:

```powershell
node bin/chartermesh.mjs configure-project --target TARGET `
  --preferences-file PREFERENCES_FILE `
  --host codex `
  --executable-sha256 HOST_SHA256 --allow-unrestricted-read --json
```

Use `--host claude` and omit the Codex acknowledgement for Claude. Preserve these
options when repeating the approved command. A changed executable needs a new
preview; multiple installed native hosts are rejected rather than partly
updated. This does not connect a new host or grant native write/shell authority.
Preferences-only changes may omit `--host` to update the shared preferences and
guidance without regenerating native role files. Restart host sessions to load
the updated guidance; do not claim that native projection was refreshed unless
the approved plan actually included it.

Removed role projections become retired-role notices so an old role file is
not left looking active. After an approved projection refresh, close old host
sessions, start a new session from the project root, and verify
`chartermesh_status` and `chartermesh_work_next` before assigning work. Do not
assume an existing session has reloaded new preferences or roles.

## Preserve and recover

An applied customization leaves a marker that prevents ordinary `bootstrap`
from replacing the tailored project with a default template. Use
`configure-project` for later changes, not rebootstrap or kickoff as a reset.
Bootstrap/kickoff preserve saved preferences where applicable; the marker's
overwrite protection still takes precedence. Existing connection commands
preserve preferences as well.

For an interrupted apply, inspect with `doctor` and use the explicit `recover`
flow or resume the exact approved operation. Do not delete transaction journals
or the customization marker to bypass safeguards. Reverting a completed
customization requires a new reviewed candidate and approval; there is no
promise that past model calls or external effects can be undone. This
configuration operation itself does not start a model call, publish, deploy,
or install packages.

The pending maintenance marker and the exact approved plan are committed
together in Control Plane metadata before file replacement. Work mutations
remain blocked after a crash until that same approved plan resumes; a lost or
edited candidate input is not needed to reconstruct it. Existing MCP and
dashboard sessions reject mutations after the organization changes, and must
be restarted to load the new policy. Read-only inspection stays available.
An approved refresh also updates installation and managed command version pins
while preserving the current organization and unrelated guide text.
