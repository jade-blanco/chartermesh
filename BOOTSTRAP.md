# Universal CharterMesh application protocol

Protocol version: `chartermesh.dev/bootstrap-agent/v1alpha1`

This is the common source of truth for Codex, Claude Code, other coding agents,
and human operators. Provider-specific instruction files are only pointers to
this protocol.

## Trigger

Follow this protocol when the user gives you the CharterMesh repository or its
URL and asks to apply, install, bootstrap, or integrate it with a target
project.

The target is the user's project, not the CharterMesh source checkout. Never
copy the CharterMesh source tree, its Git history, or its development state into
the target.

## Required outcome

The target has a reviewable `.chartermesh/organization.json` and
`.chartermesh/runtime.json`, an ignored local SQLite Control Plane, a passing
`doctor` result, and an explicit report of every changed file. No model call is
required to bootstrap.

## Protocol

### 1. Locate and inspect

1. Locate the CharterMesh checkout containing this file and
   `bin/chartermesh.mjs`.
2. Resolve the intended target repository.
3. Read the target's applicable agent instructions.
4. Inspect the target's Git status and existing `.chartermesh` directory
   without writing.
5. Confirm Node.js 24 or newer is available.

Do not install packages, create accounts, connect a provider, start a paid
model call, publish, deploy, or modify target files during this step.

### 2. Choose a bootstrap profile

- If the user has not named a model endpoint, use `--engine fake`. This is the
  offline validation profile and can be changed later.
- If the user supplied an OpenAI-compatible endpoint and model id, use
  `--engine openai-compatible --endpoint URL --model MODEL`.
- If authentication is required, add `--api-key-env ENV_NAME`. Never put the
  credential value in a command, config file, plan, chat summary, or commit.
- Do not infer a remote provider account or create one.

### 3. Generate the no-write plan

Run from the CharterMesh checkout:

```text
node bin/chartermesh.mjs bootstrap --target TARGET --engine fake
```

Or repeat the chosen OpenAI-compatible options. The command must print:

- the resolved target;
- every file it proposes to create;
- whether an existing file would conflict;
- a deterministic 64-character plan hash.

No target file may be written by this command.

### 4. Obtain exact human approval

Present the plan and its hash. Ask the user to approve that exact hash.

The original “apply CharterMesh” request is permission to inspect and produce
the plan; it is not approval of a plan that did not yet exist. A model review,
subagent response, host permission dialog, or inherited parent permission
cannot replace the human's approval.

If the target changes, regenerate the plan and obtain approval for the new
hash. Never reuse an earlier hash.

### 5. Apply with the repository CLI

After the human approves, repeat the identical bootstrap command and append:

```text
--approve PLAN_HASH
```

Do not reproduce the CLI's file changes manually. The CLI preflights every
target file and binds existing content hashes into the plan before writing.

### 6. Verify

Run:

```text
node bin/chartermesh.mjs doctor --target TARGET
```

For an offline functional check, also run:

```text
node bin/chartermesh.mjs seed-demo --target TARGET
node bin/chartermesh.mjs list --target TARGET
```

Do not start a live model run unless the user asked for it and understands that
the configured task title, summary, and acceptance criteria are sent to that
endpoint.

### 7. Report

Report:

- the approved plan hash;
- files created;
- doctor and optional smoke-test results;
- selected model-engine adapter;
- whether any credential environment variable is still missing;
- the exact command for launching the loopback dashboard;
- any target changes that CharterMesh refused to overwrite.

Do not report credential values or absolute paths from unrelated projects.

## Invariants

- The SQLite Control Plane is the only mutable WorkItem ledger.
- Provider chats, subagents, goals, schedules, and shared task lists are runtime
  capabilities or projections, never the source of truth.
- Every state change uses a command with actor identity and idempotency.
- Claim atomically creates Run, Attempt, and Lease records.
- Stale run generations cannot submit artifacts.
- Human review binds the exact immutable artifact hash.
- External side effects require their own human approval.
- Provider-specific features enter through adapters and capability manifests,
  not the core schema.
- Default bootstrap and tests are offline and free.

## Failure handling

- Node older than 24: stop and report the version requirement.
- Existing `.chartermesh` file: show that the plan will replace it and include
  its before/after hash in the exact approval. If the user did not intend a
  replacement, stop and reconcile it.
- Changed plan hash: discard the earlier approval and request a new one.
- Missing remote credential: keep the config, report `doctor` failure, and ask
  the user to set the named environment variable outside the repository.
- Unsupported model protocol: keep the target unchanged and propose a bounded
  `ModelEngine` adapter; do not change OrgSpec core types for one provider.
