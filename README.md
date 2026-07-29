# CharterMesh

CharterMesh is a local-first, provider-neutral control plane for turning a
request into assigned work, model-assisted artifacts, exact human review, and
an auditable completion record.

Give this repository URL to Codex, Claude Code, or another capable coding
agent and say:

> Apply CharterMesh to this project.

The agent reads [`BOOTSTRAP.md`](BOOTSTRAP.md), inspects the target without
writing, generates an immutable plan hash, and asks you to approve that exact
hash before it applies anything. A human can run the same flow directly from a
terminal.

## Why it is engine-neutral

- `ModelEngine` is inference only. The included generic adapter speaks the
  OpenAI-compatible Chat Completions protocol.
- `ManagedRunner` owns the product-controlled run and can receive any
  conforming model engine.
- `AgentHost` represents optional external agent products. Codex and Claude
  Code are hosts that can apply or integrate CharterMesh; neither owns the
  CharterMesh ledger.
- `OrgSpec`, WorkItems, runs, immutable artifact hashes, approvals, usage, and
  events remain provider-neutral Control Plane state.

## Runnable pre-alpha slice

- Safe bootstrap preview with exact plan-hash approval
- SQLite Control Plane with WorkItem, dependency, Run, Attempt, Lease,
  artifact, approval, model-usage, event, and idempotency records
- Generation fencing that rejects stale runner results
- Exact artifact-hash review
- Deterministic offline fake model engine
- Generic OpenAI-compatible engine adapter
- Built-in managed runner
- CLI work lifecycle
- Responsive, action-centric local dashboard
- Versioned OrgSpec schema, semantic validator, capability negotiation, and
  install-plan hash binding

## Requirements

- Node.js 24 or newer
- pnpm 11 for repository verification

There are no runtime npm dependencies in this slice.

## Five-minute offline start

From the CharterMesh checkout, preview the files that would be added to a
target project:

```powershell
node bin/chartermesh.mjs bootstrap --target C:\path\to\your-project --engine fake
```

The command prints a 64-character approval token and performs no target writes.
Repeat the identical command with that token:

```powershell
node bin/chartermesh.mjs bootstrap --target C:\path\to\your-project --engine fake --approve PLAN_HASH
node bin/chartermesh.mjs doctor --target C:\path\to\your-project
node bin/chartermesh.mjs seed-demo --target C:\path\to\your-project
node bin/chartermesh.mjs dashboard --target C:\path\to\your-project
```

Open the printed loopback URL. The fake engine is deterministic, free, and
offline; it is the recommended first verification path.

On macOS or Linux, use the same commands with a POSIX target path.

## Connect a real or local model

Bootstrap with an OpenAI-compatible base URL and the exact model identifier
served by your provider:

```powershell
node bin/chartermesh.mjs bootstrap `
  --target C:\path\to\your-project `
  --engine openai-compatible `
  --endpoint http://127.0.0.1:11434/v1 `
  --model YOUR_MODEL_ID
```

For a provider that requires a key, pass only the environment-variable name:

```powershell
$env:CHARTERMESH_MODEL_API_KEY = "set-this-only-in-your-shell-or-secret-store"
node bin/chartermesh.mjs bootstrap `
  --target C:\path\to\your-project `
  --engine openai-compatible `
  --endpoint https://provider.example/v1 `
  --model YOUR_MODEL_ID `
  --api-key-env CHARTERMESH_MODEL_API_KEY
```

The key value is never written to CharterMesh configuration. See
[`docs/LLM-CONNECTIONS.md`](docs/LLM-CONNECTIONS.md) for Ollama, LM Studio,
vLLM, and remote-provider examples.

## Operate from the CLI

```powershell
node bin/chartermesh.mjs request "Prepare release notes" --summary "Draft concise reviewed notes." --target C:\path\to\your-project
node bin/chartermesh.mjs triage --id work-000001 --role operator --target C:\path\to\your-project
node bin/chartermesh.mjs run --id work-000001 --target C:\path\to\your-project
node bin/chartermesh.mjs decide --id work-000001 --decision approve --artifact-hash SHA256_FROM_RUN --note "Reviewed." --target C:\path\to\your-project
node bin/chartermesh.mjs complete --id work-000001 --target C:\path\to\your-project
```

The same lifecycle is explained in [`docs/USAGE.md`](docs/USAGE.md).

## Local files added to a target

```text
.chartermesh/
├─ organization.json  # reviewable desired organization
├─ runtime.json       # adapter config; environment-variable names only
├─ README.md
├─ .gitignore
├─ state.db           # mutable source of truth; ignored
└─ artifacts/         # content-addressed review artifacts; ignored
```

CharterMesh does not create a Markdown task ledger or treat a provider chat as
authoritative.

## Verify the source

```powershell
pnpm verify
```

All default tests are offline and free. Live provider calls are opt-in.

## Project status

This is a usable pre-alpha source release, not a production authorization
system. The dashboard currently creates and inspects requests; complete
triage/run/review operations are available through the CLI. Review
[`SECURITY.md`](SECURITY.md) before connecting a paid or remote model.

Key documents:

- [`BOOTSTRAP.md`](BOOTSTRAP.md) — universal coding-agent application protocol
- [`docs/FIRST-RUN.md`](docs/FIRST-RUN.md) — first configuration
- [`docs/LLM-CONNECTIONS.md`](docs/LLM-CONNECTIONS.md) — model connection guide
- [`docs/USAGE.md`](docs/USAGE.md) — operating workflow
- [`docs/PRODUCT-DESIGN.md`](docs/PRODUCT-DESIGN.md) — architecture source of truth
- [`docs/DASHBOARD-DESIGN.md`](docs/DASHBOARD-DESIGN.md) — UI contract
- [`SECURITY.md`](SECURITY.md) — security and vulnerability reporting

Licensed under the [Apache License 2.0](LICENSE).
