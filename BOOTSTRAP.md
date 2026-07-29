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

It also has an ignored local SQLite Control Plane, a passing `doctor` result,
and a report of every changed file. No model call is required to bootstrap.

## Protocol

### 1. Locate the executable and inspect

1. Prefer an already available CharterMesh executable. A source checkout may
   use `node bin/chartermesh.mjs`. With only the GitHub URL, and after the user
   authorizes the one-time package download, use
   `npx --yes github:jade-blanco/chartermesh`.
2. Resolve the intended target repository.
3. Read the target's applicable agent instructions.
4. Inspect its Git status and existing `.chartermesh` directory without
   writing.
5. Confirm Node.js 24 or newer.

Do not install packages, create accounts, connect a provider, start a paid
model call, publish, deploy, or modify target files during this step.

### 2. Propose an operating profile

Run with the selected executable prefix:

```text
chartermesh propose --target TARGET --profile balanced --json
```

Use `lean`, `balanced`, or `controlled` when the user requested one. Otherwise,
recommend `balanced`. Show the assessment, rationale, proposal hash, and risk
signals. This command performs no target writes.

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

### 4. Generate the no-write plan

```text
chartermesh bootstrap --target TARGET --profile balanced --engine fake --json
```

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
rolls back an interrupted one on the next `bootstrap`, `configure-engine`,
`doctor`, or `recover` command.

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
- Stale generations cannot submit artifacts.
- Human review binds the exact immutable artifact hash.
- Tool availability, workspace roots, and iteration limits come from OrgSpec.
- Workspace writes require approval of the exact canonical tool-call hash.
- Tool evidence records hashes, status, bounded paths, and timing, not raw
  arguments or output.
- Unknown model cost follows OrgSpec `warn`, `block`, or `estimate` policy and
  is never silently converted to zero.
- Artifact byte limits come from OrgSpec.
- External side effects require their own human approval.
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
- `TOOL_APPROVAL_REQUIRED`: show the exact call hash and tool name, obtain a
  human `approve-tool` command, then use `retry` and start a new generation.
- Interrupted file apply: run `doctor` or `recover`; do not delete the journal
  or backup files manually.
- Restore: generate the exact `restore --backup BACKUP_ID` plan, including the
  DB and artifact-set hashes, obtain human approval for its current hash, and
  repeat with `--approve PLAN_HASH`. Restore takes the maintenance lock and
  rejects concurrent writers; stop another process only if its SQLite sidecar
  prevents checkpointing.
