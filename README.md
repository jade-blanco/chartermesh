# CharterMesh

CharterMesh is a local-first, provider-neutral control plane that turns a
request into assigned work, model-assisted artifacts, exact human review, and
an auditable completion record.

Give this repository URL to Codex, Claude Code, Gemini CLI, or another capable
coding agent and say:

> Apply CharterMesh to this project.

The agent reads [`BOOTSTRAP.md`](BOOTSTRAP.md), inspects the target without
writing, proposes a project-aware organization, generates an immutable plan
hash, and waits for a human to approve that exact hash. A human or shell script
can use the same versioned CLI contract.

## Why any LLM can be the engine

- `ModelEngine` handles inference behind a small provider-neutral contract.
- `ManagedRunner` owns structured output, bounded repair, cancellation, and
  Control Plane submission.
- `AgentHost` represents optional products such as Codex or Claude Code.
- OrgSpec, WorkItems, runs, attempts, leases, artifacts, approvals, budgets,
  usage, and events stay in CharterMesh rather than a provider chat.

The included OpenAI-compatible adapter works with local or remote servers that
implement Chat Completions. Provider-specific features enter through adapter
capability manifests, never through the core OrgSpec schema.

## 0.0.2-alpha.1 runnable slice

- Project-aware `lean`, `balanced`, and `controlled` proposals
- Exact plan-hash approval and staged, rollback-on-error apply
- Dependency-free OrgSpec JSON Schema plus semantic validation
- SQLite Control Plane with transactional commands and outbox
- Generation fencing, lease heartbeat/recovery, visible failure, and retry
- Enforced concurrency, daily-start, and monthly-cost budgets
- Structured artifacts with one bounded repair turn and real cancellation
- Fake and generic OpenAI-compatible model engines
- Versioned `--json` CLI output for coding agents and automation
- Dashboard request, triage, run, artifact review, retry, approval, and complete
- Synthetic local-model evaluation for comparing small models

This is pre-alpha software, not a production authorization system.

## Requirements

- Node.js 24 or newer
- pnpm 11 for source verification

There are no runtime npm dependencies in this slice.

## Five-minute offline start

First inspect the project-aware proposal:

```powershell
node bin/chartermesh.mjs propose --target C:\path\to\project --profile balanced
```

Preview the exact bootstrap plan. This performs no target writes:

```powershell
node bin/chartermesh.mjs bootstrap --target C:\path\to\project --profile balanced --engine fake
```

Repeat the identical command with the printed hash:

```powershell
node bin/chartermesh.mjs bootstrap --target C:\path\to\project --profile balanced --engine fake --approve PLAN_HASH
node bin/chartermesh.mjs doctor --target C:\path\to\project
node bin/chartermesh.mjs seed-demo --target C:\path\to\project
node bin/chartermesh.mjs dashboard --target C:\path\to\project
```

The fake engine is deterministic, free, and offline.

## Connect a local or remote model

Configure the exact base URL and served model identifier:

```powershell
node bin/chartermesh.mjs configure-engine `
  --target C:\path\to\project `
  --engine openai-compatible `
  --endpoint http://127.0.0.1:8080/v1 `
  --model YOUR_MODEL_ID `
  --structured-output prompt `
  --reasoning disabled
```

This prints a separate configuration plan. Review it, then repeat it with
`--approve PLAN_HASH`.

For a remote endpoint, pass only the environment-variable name:

```powershell
$env:CHARTERMESH_MODEL_API_KEY = "set-only-in-this-shell-or-a-secret-store"
node bin/chartermesh.mjs configure-engine `
  --target C:\path\to\project `
  --engine openai-compatible `
  --endpoint https://provider.example/v1 `
  --model YOUR_MODEL_ID `
  --api-key-env CHARTERMESH_MODEL_API_KEY
```

Credential values are never written to CharterMesh files. Plain HTTP with a
credential is rejected unless the endpoint is loopback.

See [`docs/LLM-CONNECTIONS.md`](docs/LLM-CONNECTIONS.md).

## Evaluate a local model

After the engine is configured and serving:

```powershell
node bin/chartermesh.mjs evaluate-model --target C:\path\to\project --live --json
```

The evaluation sends only three synthetic tasks. It records structure
compliance, instruction retention, latency, and token counts when available.
It never sends project files. See
[`docs/MODEL-EVALUATION.md`](docs/MODEL-EVALUATION.md).

## Operate from the CLI

```powershell
node bin/chartermesh.mjs request "Prepare release notes" --summary "Draft concise reviewed notes." --target TARGET
node bin/chartermesh.mjs triage --id work-000001 --role operator --target TARGET
node bin/chartermesh.mjs run --id work-000001 --target TARGET
node bin/chartermesh.mjs decide --id work-000001 --decision approve --artifact-hash SHA256_FROM_RUN --note "Reviewed." --target TARGET
node bin/chartermesh.mjs complete --id work-000001 --target TARGET
```

Add `--json` to agent-facing commands for the
`chartermesh.dev/cli/v1alpha1` envelope.

## Local files added to a target

```text
.chartermesh/
├─ proposal.json       # target assessment, rationale, and proposed OrgSpec
├─ organization.json   # reviewable desired organization
├─ runtime.json        # adapter config; environment-variable names only
├─ installation.json   # CharterMesh version and proposal hashes
├─ README.md
├─ .gitignore
├─ state.db            # mutable source of truth; ignored
└─ artifacts/          # content-addressed review artifacts; ignored
```

CharterMesh does not create a Markdown task ledger or treat a provider chat as
authoritative.

## Verify the source

```powershell
pnpm verify
```

All default tests are offline and free. Live model calls require `--live`.

Key documents:

- [`BOOTSTRAP.md`](BOOTSTRAP.md) — universal application protocol
- [`docs/FIRST-RUN.md`](docs/FIRST-RUN.md) — first configuration
- [`docs/LLM-CONNECTIONS.md`](docs/LLM-CONNECTIONS.md) — model connection guide
- [`docs/MODEL-EVALUATION.md`](docs/MODEL-EVALUATION.md) — small-model experiment
- [`docs/USAGE.md`](docs/USAGE.md) — operating workflow
- [`docs/PRODUCT-DESIGN.md`](docs/PRODUCT-DESIGN.md) — architecture source of truth
- [`SECURITY.md`](SECURITY.md) — security and vulnerability reporting

Licensed under the [Apache License 2.0](LICENSE).
