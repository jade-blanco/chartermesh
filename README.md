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

처음 설치하고 운영하는 사용자는
[`한국어 사용자 설명서`](docs/USER-GUIDE.ko.md)를 따라 전체 흐름을
확인할 수 있습니다.

## Why any LLM can be the engine

- `ModelEngine` handles inference behind a small provider-neutral contract.
- `ManagedRunner` owns structured output, bounded repair, cancellation, and
  Control Plane submission.
- `AgentHost` represents optional products such as Codex or Claude Code.
- OrgSpec, WorkItems, runs, attempts, leases, artifacts, approvals, budgets,
  usage, and events stay in CharterMesh rather than a provider chat.

The included OpenAI-compatible adapter works with local or remote servers that
implement Chat Completions. The command-process adapter can connect any local
executable that implements CharterMesh's neutral stdin/stdout JSON contract.
Provider-specific features enter through adapter capability manifests, never
through the core OrgSpec schema.

## 0.0.7-alpha.1 runnable slice

- Project-aware `lean`, `balanced`, and `controlled` proposals
- Exact plan-hash approval and crash-recoverable journaled apply
- Dependency-free OrgSpec JSON Schema plus semantic validation
- SQLite Control Plane with transactional commands and retryable outbox
- Generation fencing, lease heartbeat/recovery, visible failure, and retry
- Durable model-invocation start/finish records plus shared CLI, dashboard,
  signal, and cross-process cancellation
- Multi-process claim, idempotency, and database-lock stress coverage
- Enforced concurrency, daily-start, and monthly-cost budgets
- User-owned unknown-cost policy, optional token-price estimation, and
  per-artifact/work-item byte limits
- Policy-gated tool execution with path containment, exact-call approval,
  hash-only evidence, and bounded iterations
- Structured artifacts with one bounded repair turn and cancellation
- Fake, generic OpenAI-compatible, and shell-free, executable-hash-pinned
  command-process engines with dedicated working directories
- Rate-limited local dashboard APIs and keyboard/mobile accessibility flow
- Cursor-paged WorkItems, explicit terminal-work archive, and memory-bounded
  allowlisted JSONL audit export
- Claim/retry/dead-letter outbox dispatcher plus hashed SQLite+artifact backup
  and maintenance-locked approved restore
- Optional local interval scheduler, disabled by default, that starts zero
  models when no claimable work exists
- Human-controlled pause/resume for new run starts and bounded,
  no-redirect HTTP model responses
- Versioned `--json` CLI output for coding agents and automation
- Dashboard request, triage, run, artifact review, retry, approval, and complete
- Synthetic local-model evaluation for comparing small models
- Buildable dependency-free npm package and clean-install verification
- Four bundled Apache-2.0 Agent Skills copied by the exact bootstrap plan
- Agent-readable capability catalog with every external integration disabled
  by default
- Optional approval-gated SearXNG `web.search` with bounded network behavior
- Evidence-grounding instructions validated with a local Gemma 4 workflow

This is pre-alpha software, not a production authorization system.

## Requirements

- Node.js 24 or newer
- pnpm 11 for source verification

There are no runtime npm dependencies in this slice.

## Portable skills and free integrations

Every approved bootstrap installs these provider-neutral Agent Skills under
`.chartermesh/skills/`:

- `web-research`
- `repository-diagnostics`
- `small-model-evidence`
- `integration-review`

They follow the open `SKILL.md` package format and are Apache-2.0. Skill text
guides a model but never grants tools or replaces OrgSpec.

Inspect the bundled and optional capabilities without installing anything:

```powershell
node bin/chartermesh.mjs skills list --json
node bin/chartermesh.mjs capabilities recommend --json
node bin/chartermesh.mjs capabilities list --json
```

The catalog includes the official MCP reference Fetch, Filesystem, and Git
servers plus Microsoft Playwright MCP. They are not automatically downloaded
or executed. Filesystem and Git usually duplicate narrower native capabilities;
Fetch and browser automation expand network/session access and therefore need
a separate reviewed installation plan.

For provider-neutral search without a commercial API, supply a reviewed
SearXNG Search API endpoint while configuring a tool-calling engine:

```powershell
node bin/chartermesh.mjs configure-engine `
  --target C:\path\to\project `
  --engine openai-compatible `
  --endpoint http://127.0.0.1:8080/v1 `
  --model YOUR_MODEL_ID `
  --tool-calling `
  --web-search-searxng http://127.0.0.1:8888/search
```

Search is absent by default. HTTPS or loopback HTTP is required; credentials
and redirects are rejected; responses are bounded; result pages are not
fetched. Each exact query requires human Control Plane approval before it
leaves the machine. The approved configuration plan updates `runtime.json` and
the selected OrgSpec role together; use `--web-search-role ROLE_ID` when the
role is not `operator`. Use `--disable-web-search` in a later approved engine
plan to remove the endpoint and its role grants.

## One-command entry from the GitHub URL

On a machine with Node.js 24 or newer, a human, coding agent, or shell can run
CharterMesh without manually checking out this source tree:

```powershell
npx --yes github:jade-blanco/chartermesh propose --target C:\path\to\project --profile balanced --json
npx --yes github:jade-blanco/chartermesh bootstrap --target C:\path\to\project --profile balanced --engine fake --json
```

`bootstrap` returns the exact plan hash and still performs no target writes.
After a human approves that value, repeat the same command with
`--approve PLAN_HASH`. The GitHub package path builds dependency-free
JavaScript before execution. Downloading the package requires network access
and should be explicitly authorized in managed agent environments.

## Five-minute offline source start

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

`doctor` automatically compares the target's pinned installation version with
the running CLI and recovers any incomplete apply journal. Use
`chartermesh version --check` for an explicit network check of the latest
GitHub release.

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

To connect an arbitrary local engine wrapper without a vendor API:

```powershell
node bin/chartermesh.mjs configure-engine `
  --target C:\path\to\project `
  --engine command-process `
  --command C:\absolute\path\to\engine.exe `
  --command-arg --serve-chartermesh `
  --pass-env LOCAL_MODEL_HOME
```

The executable path must be absolute. CharterMesh uses no shell, passes only
explicitly allowed environment variables plus minimal OS temporary-directory
variables, and caps execution time and output size.

## Evaluate a local model

After the engine is configured and serving:

```powershell
node bin/chartermesh.mjs evaluate-model --target C:\path\to\project --live --json
node bin/chartermesh.mjs evaluate-collaboration --target C:\path\to\project --live --repetitions 3 --json
node bin/chartermesh.mjs evaluate-collaboration --target C:\path\to\project --live `
  --engine-id small-worker --reviewer-engine-id stronger-reviewer `
  --fixture concurrent-claim-hardening --json
```

The evaluation sends only three synthetic tasks. It records structure
compliance, instruction retention, latency, and token counts when available.
It never sends project files. Repeated `--fixture` options run an explicitly
reported screening subset. A reviewer engine affects only verifier and
synthesizer in the delegated condition. See
[`docs/MODEL-EVALUATION.md`](docs/MODEL-EVALUATION.md).

Repository contributors can also run the opt-in executable-work harness
directly against a loopback OpenAI-compatible server:

```powershell
pnpm evaluate:execution -- `
  --endpoint http://127.0.0.1:8080/v1 `
  --model LOCAL_MODEL_ID `
  --engine-id local-small `
  --tier-id small `
  --task-count 100 `
  --probe-count 200 `
  --reasoning-mode disabled `
  --output .chartermesh/artifacts/execution-small.json
```

Use `--resume PREVIOUS_REPORT` with a new `--tier-id`, endpoint, and model to
run only pending tasks at a stronger tier. The harness uses synthetic
configuration data in temporary Git repositories and hidden deterministic
tests. It does not execute model-generated source code or grant the model
tools. See [`docs/MODEL-EVALUATION.md`](docs/MODEL-EVALUATION.md).

Repository contributors can opt into the stronger code-maintenance pilot to
compare E4B, 26B, and Qwen single-model baselines with an
E4B-to-26B-to-Qwen review chain under the same requested output-token ceiling.
Generation never executes candidate code. A separate evaluation command runs
each frozen candidate in its own verified Windows Sandbox VM with networking
and ambient host channels disabled. The command fails closed when the VM
feature or any live canary is unavailable. Setup, engine fingerprint flags,
and commands are documented in
[`docs/MODEL-EVALUATION.md`](docs/MODEL-EVALUATION.md).

To compare single-model and command-mediated team workflows across coding,
product, research, spreadsheet, document, and presentation tasks, first create
a no-inference study plan. A live run requires the exact regenerated plan hash:

```powershell
node bin/chartermesh.mjs evaluate-workflow --target TARGET --fixture product-package-easy-001 `
  --engine-id local-model --codex-executable C:\absolute\path\to\codex.exe `
  --codex-sha256 SHA256 --codex-model CODEX_MODEL --json
```

The six-arm study is documented in
[`docs/COLLABORATION-STUDY.md`](docs/COLLABORATION-STUDY.md). Codex is a
simulated ordinary-user proxy, never the production human approver. Code
fixtures additionally require a passing attested Windows Sandbox preflight.
Live reports retain the exact approved plan, enforce the provider-reported
model identity, and use a per-plan lock. After confirming a stopped process,
`--restart-checkpoint` preserves its abandoned run and starts a fresh isolated
ledger.

## Operate from the CLI

```powershell
node bin/chartermesh.mjs request "Prepare release notes" --summary "Draft concise reviewed notes." --target TARGET
node bin/chartermesh.mjs triage --id work-000001 --role operator --target TARGET
node bin/chartermesh.mjs run --id work-000001 --target TARGET
node bin/chartermesh.mjs run --id work-000001 --delegated --target TARGET
node bin/chartermesh.mjs decide --id work-000001 --decision approve --artifact-hash SHA256_FROM_RUN --note "Reviewed." --target TARGET
node bin/chartermesh.mjs complete --id work-000001 --target TARGET
```

Add `--json` to agent-facing commands for the
`chartermesh.dev/cli/v1alpha1` envelope.

Active runs can be canceled from another CLI or from the dashboard. Ctrl+C
uses the same durable Control Plane cancellation command:

```powershell
node bin/chartermesh.mjs cancel --id work-000001 --target TARGET
node bin/chartermesh.mjs list --target TARGET --active-only --limit 100 --json
node bin/chartermesh.mjs archive --id work-000001 --target TARGET
```

Local schedules are opt-in OrgSpec entries. The default proposal contains no
schedules. Once a human-approved OrgSpec has an active controller schedule,
run one tick or keep a local watcher alive:

```powershell
node bin/chartermesh.mjs scheduler tick --target TARGET --json
node bin/chartermesh.mjs scheduler watch --target TARGET --poll-ms 30000
```

The dependency-free scheduler currently accepts
`FREQ=MINUTELY|HOURLY|DAILY;INTERVAL=N`. It checks the Control Plane first and
records `skipped_no_work` without starting a model.

If a model requests `workspace.write_file`, CharterMesh does not execute it
until a human approves the exact call hash:

```powershell
node bin/chartermesh.mjs approve-tool --id work-000001 --call-hash CALL_SHA256 --tool workspace.write_file --target TARGET
node bin/chartermesh.mjs run --id work-000001 --target TARGET
node bin/chartermesh.mjs tool-evidence --id work-000001 --target TARGET --json
```

The unapproved call waits without changing the WorkItem to failed. Exact human
approval returns it to ready, and the next `run` uses a new fenced generation.

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
├─ artifacts/          # content-addressed review artifacts; ignored
├─ backups/            # hashed DB snapshots + deduplicated artifact blobs
├─ engine-work/        # isolated cwd for local command engines; ignored
└─ exports/            # allowlisted audit JSONL; ignored
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
- [`docs/USER-GUIDE.ko.md`](docs/USER-GUIDE.ko.md) — 한국어 사용자 설명서
- [`docs/FIRST-RUN.md`](docs/FIRST-RUN.md) — first configuration
- [`docs/LLM-CONNECTIONS.md`](docs/LLM-CONNECTIONS.md) — model connection guide
- [`docs/MODEL-EVALUATION.md`](docs/MODEL-EVALUATION.md) — small-model experiment
- [`docs/COLLABORATION-STUDY.md`](docs/COLLABORATION-STUDY.md) — longitudinal single/team validation
- [`docs/USAGE.md`](docs/USAGE.md) — operating workflow
- [`docs/PRODUCT-DESIGN.md`](docs/PRODUCT-DESIGN.md) — architecture source of truth
- [`SECURITY.md`](SECURITY.md) — security and vulnerability reporting

Licensed under the [Apache License 2.0](LICENSE).
