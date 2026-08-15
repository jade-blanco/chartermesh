# Universal CharterMesh application protocol

Protocol version: `chartermesh.dev/bootstrap-agent/v1alpha1`

This is the common source of truth for Codex, Claude Code, Gemini CLI, other
coding agents, scripts, and human operators. Provider-specific instruction
files are pointers to this protocol.

## Trigger

Follow this protocol when the user gives you the CharterMesh repository or URL
and asks to apply, install, bootstrap, or integrate it with a target project.

The target is the user's project, not the CharterMesh source checkout. Never
copy the CharterMesh source tree, Git history, or development state into it.

## Required outcome

The target has reviewable:

- `.chartermesh/proposal.json`
- `.chartermesh/organization.json`
- `.chartermesh/runtime.json`
- `.chartermesh/installation.json`
- `.chartermesh/AGENT-ENTRYPOINT.md`
- `.chartermesh/skills/*/SKILL.md`

It also has an ignored local SQLite Control Plane, a passing `doctor` result,
and a report of every changed file. No model call is required to bootstrap.

For a new or empty project whose requirements are supplied as a brief, the
required outcome additionally includes `.chartermesh/PROJECT-BRIEF.md`, root
`CHARTERMESH.md`, and one triaged WorkItem bound to explicit acceptance
criteria.

## Protocol

### 1. Locate the executable and inspect

1. Prefer an already available CharterMesh executable. A source checkout may
   use `node bin/chartermesh.mjs`. With only the GitHub URL, and after the user
   authorizes the one-time package download, use
   `npx --yes github:jade-blanco/chartermesh#v0.0.9-alpha.1` to select the
   friend-trial release, or omit the tag only when the user explicitly wants
   the latest `main` branch. A Git tag is movable and is not a cryptographic
   commit attestation.
2. Resolve the intended target repository.
3. Read the target's applicable agent instructions.
4. Inspect its Git status and existing `.chartermesh` directory without
   writing.
5. Confirm Node.js 24 or newer. When using the GitHub `npx` ref, also confirm
   Git 2.x is available; npm resolves that package form through Git. The GitHub
   path uses the repository's dependency-free `prepare` lifecycle build, so an
   environment that forces npm `ignore-scripts` must use a reviewed prebuilt
   package or source checkout instead.

Do not install packages, create accounts, connect a provider, start a paid
model call, publish, deploy, or modify target files during this step.

### 2. Propose an operating profile

Run with the selected executable prefix:

```text
chartermesh propose --target TARGET --profile balanced --json
```

Use `lean`, `balanced`, or `controlled` when the user requested one. Otherwise,
recommend `balanced`; recommend `controlled` when they explicitly want
separate operator and verifier roles. Show the assessment, rationale, proposal
hash, and risk signals. This command performs no target writes.

### 3. Choose the bootstrap engine

- Without a user-supplied endpoint, use `--engine fake`.
- With an OpenAI-compatible endpoint and model id, use
  `--engine openai-compatible --endpoint URL --model MODEL`.
- With a local executable that implements the neutral JSON contract, use
  `--engine command-process --command ABSOLUTE_PATH` and repeat
  `--command-arg` as needed.
- If authentication is required, add `--api-key-env ENV_NAME`. Never place the
  credential value in a command, config, plan, chat summary, or commit.
- Do not infer or create a remote provider account.
- Add `--web-search-searxng URL` only when the user supplied or approved a
  reviewed SearXNG endpoint and the selected engine supports tool calls. For
  OpenAI-compatible engines, also add `--tool-calling`.

### 4. Generate the no-write plan

```text
chartermesh bootstrap --target TARGET --profile balanced --engine fake --json
```

For a new project, prefer the single kickoff plan instead. Treat the user's
request as the brief, pass it through a temporary or user-supplied brief file,
and do not create that file inside the target before approval:

```text
chartermesh kickoff --target TARGET --brief-file BRIEF_FILE --profile balanced --engine fake --json
```

`kickoff` includes the bootstrap files, immutable project brief, acceptance
contract, and first triaged WorkItem in the approved operation. Repeat the
same `kickoff` command—not `bootstrap`—when applying its hash.

Or use the chosen engine options. Parse the versioned JSON response and show:

- resolved target;
- every proposed file;
- before/after hashes;
- deterministic 64-character plan hash.

No target file may be written by this command.

### 5. Obtain exact human approval

Present the plan and its hash. Ask the user to approve that exact hash.

The original "Apply CharterMesh" request authorizes inspection and plan
generation. It does not approve a plan that did not yet exist. A model review,
subagent response, host permission dialog, or inherited permission cannot
replace the human approval.

If target state changes, regenerate the plan and obtain approval for the new
hash.

### 6. Apply with the repository CLI

After approval, repeat the identical bootstrap command and append:

```text
--approve PLAN_HASH
```

Do not reproduce file changes manually. The CLI preflights current target
hashes, stages and verifies proposed content, writes an immutable journal
before the first replacement, and either finalizes a committed transaction or
stops with its recovery evidence intact. No-write plan and `doctor` commands
only report an incomplete transaction. Run the explicit `recover` command, or
resume the exact already-approved apply operation, to roll it back or finalize
it.

### 7. Verify

```text
chartermesh doctor --target TARGET --json
```

For an offline functional check:

```text
chartermesh seed-demo --target TARGET
chartermesh list --target TARGET --json
```

Do not start a live model call unless the user asked for it and understands
that the configured task packet is sent to that endpoint. `evaluate-model`
requires explicit `--live` and sends only synthetic tasks.

### 7.1 Optional coding-host integration

If the user wants the current Codex or Claude Code session to use the
CharterMesh team, first run the read-only host probe:

```text
chartermesh host doctor --host codex --target TARGET --json
```

Then generate a separate no-write projection plan:

```text
chartermesh configure-host --host codex --target TARGET --allow-unrestricted-read --json
```

Use `--host claude` for Claude Code. Show its files, executable and capability
hashes, and exact plan hash; wait for a separate human approval and repeat the
identical command with `--approve PLAN_HASH`. The generated local MCP bridge
uses a unique non-human actor for each process and cannot approve plans, tools,
artifacts, or user input. Projection-only checks report executable/capability
declarations without starting app-server; they do not live-probe every project
feature. Use `host doctor --direct`, or an
approved `--activate-role`, only for strict Codex direct-protocol validation.

After apply, tell the user to close the old host session and start a new one
from the project root. Codex must trust the project to load
`.codex/config.toml`; Claude Code requires a one-time approval of the project
MCP entry. Verify `chartermesh_status` and `chartermesh_work_next` before
assigning work; this post-projection health gate is mandatory.

Projected role files deny native write and shell tools, but a parent host can
override child permissions. Start the parent without native write/shell
authority and treat this as a procedural pre-alpha boundary. For implementation,
they request one bounded content-addressed change set through MCP. The run then
waits for a separate human `approve-tool` decision over the exact call and
Decision Packet hashes. A new claim may execute only the stored approved bytes
through the recoverable transaction and record evidence. The MCP bridge never
resolves that approval.

One project bridge serves the aggregate allowed OrgSpec roles. Generated role
profiles must claim only their exact `ownerRole`, but the shared bridge cannot
authenticate which native subagent called it. Cross-role separation is
procedural in this alpha; the shared session/run/lease fences remain enforced.

Only Codex has a direct AgentHost runner in this alpha. Add
`--activate-role ROLE --allow-unrestricted-read` only when the user explicitly
wants `chartermesh run` to consume their Codex host quota and acknowledges that
Codex's read-only sandbox does not confine reads to the project directory.
Both flags must be bound into the previewed and approved plan. Claude uses
projected roles and the shared MCP bridge; do not claim direct Claude run
activation.

The `human:*` actor rule is a procedural Control Plane boundary, not
cryptographic proof against a local process that can invoke the CLI or modify
SQLite. Do not give an untrusted primary coding host access to the separately
controlled human approval session.

### 8. Report

Report:

- proposal, assessment, and approved plan hashes;
- selected profile and model adapter;
- files created or replaced;
- doctor and smoke-test results;
- any missing credential environment-variable name;
- dashboard command;
- any target change the CLI refused to overwrite.

Never report credential values or unrelated absolute paths.

## Invariants

- SQLite is the only mutable WorkItem ledger.
- Provider chats, subagents, goals, schedules, and task lists are capabilities
  or projections, never the source of truth.
- State changes use commands with actor identity and idempotency.
- Claim atomically creates Run, Attempt, Lease, and generation.
- A model invocation is recorded as running before inference and is closed as
  succeeded, failed, canceled, or abandoned.
- A direct AgentHost run binds its provider session and run ids to the exact
  Control Plane Run and Attempt; lease recovery abandons both together.
- Provider-native permission prompts never satisfy human approval. The first
  Codex adapter cancels them fail-closed until an exact resumable approval
  callback exists.
- Stale generations cannot submit artifacts.
- Human decisions bind the exact immutable Decision Packet hash. For artifact
  review, its subject binds the artifact bytes and media type separately from
  the producer-report hash, evidence-set hash, WorkItem version, and projection
  version.
- Tool availability, workspace roots, and iteration limits come from OrgSpec.
- Workspace writes require approval of the exact canonical tool-call hash.
- Tool evidence records hashes, status, bounded paths, and timing, not raw
  arguments or output.
- Unknown model cost follows OrgSpec `warn`, `block`, or `estimate` policy and
  is never silently converted to zero.
- Artifact byte limits come from OrgSpec.
- External side effects require their own human approval.
- External search is disabled without runtime configuration. An exact
  `web.search` query requires Control Plane approval before network egress.
- Portable Agent Skills are guidance only; they cannot expand OrgSpec tools or
  satisfy a human approval.
- Provider features enter through adapters and capability manifests.
- Default bootstrap and tests are offline and free.
- Default proposals contain no active schedules. A controller schedule checks
  for claimable work before starting a model.

## Failure handling

- Node older than 24: stop and report the requirement.
- Existing `.chartermesh` file: show its before/after hash. If replacement was
  unintended, stop and reconcile it.
- Changed plan hash: discard the old approval.
- Missing credential: keep the approved config, report `doctor` failure, and
  ask the user to set the named variable outside the repository.
- Unsupported protocol: keep the target unchanged and propose a bounded
  `ModelEngine` adapter; do not add provider fields to OrgSpec.
- Failed or expired run: preserve the failure, use `retry`, and create a new
  generation.
- Active run no longer needed: use `cancel --id WORK`; dashboard cancel and
  foreground Ctrl+C write the same Control Plane cancellation request.
- `TOOL_APPROVAL_REQUIRED`: keep the WorkItem in an explicit approval wait,
  show the exact call hash and tool name, obtain a human `approve-tool`
  command, then use `run` to start a new fenced generation. Do not classify
  the approval wait as a failure.
- Interrupted file apply: run `doctor` to inspect it, then explicit `recover`;
  do not delete the journal or backup files manually.
- Restore: generate the exact `restore --backup BACKUP_ID` plan, including the
  DB and artifact-set hashes, obtain human approval for its current hash, and
  repeat with `--approve PLAN_HASH`. Restore takes the maintenance lock and
  rejects concurrent writers; stop another process only if its SQLite sidecar
  prevents checkpointing.
