# CharterMesh

CharterMesh is a local-first, provider-neutral control plane that turns a
request into assigned work, model-assisted artifacts, exact human review, and
an auditable completion record.

Its primary job is not to claim an autonomous AI company. It compresses the
work of many models, agents, and tools into one hash-bound decision a human can
understand, verify, approve, revise, or reject.

Give this repository URL and the `v0.0.10-alpha.1` ref to
Codex, Claude Code, Gemini CLI, or another capable coding agent and say:

> Apply CharterMesh to this project.

A manual source checkout is optional. With package-download approval, use
`npx --yes github:jade-blanco/chartermesh#v0.0.10-alpha.1` as the executable
prefix for the commands below; source development can still use
`node bin/chartermesh.mjs`.

The agent reads [`BOOTSTRAP.md`](BOOTSTRAP.md), inspects the target without
writing, proposes a project-type-aware organization scaffold, generates an
immutable plan hash, and waits for a human to approve that exact hash. A human
or shell script can use the same CLI contract.

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

`model_json` remains the normal artifact mode. The experimental
`runtime_compiled` mode is currently available only through the
`BuiltInManagedRunner` API; there is no CLI or `runtime.json` selector for it
in this slice.

## 0.0.10-alpha.1 prerelease

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
  one-use Control Plane/runtime receipts, hash-only evidence, and bounded
  iterations
- Structured artifacts with one bounded repair turn and cancellation
- Decision Packet v1alpha2 with exact artifact/media-type identity, a
  separately hashed producer-report sidecar, and model-reported checks kept as
  `claimed` even when the runtime compiles the envelope
- SQLite schema v15 persistence for producer-report JSON, durable AgentHost
  run/session bindings, and actor-and-request-bound idempotency replay;
  migrated v11 artifacts remain valid with no report
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
- Decision Desk with one primary human decision, separate agent/wait/history
  queues, claimed-vs-verified evidence, exact artifact preview, exact tool
  rejection, and input requests
- Dry-by-default ten-case/20-call Codex proxy regression for comparing raw and
  Decision Packet review presentations under an exact live plan hash
- Synthetic local-model evaluation for comparing small models
- Buildable dependency-free npm package and clean-install verification
- Six bundled Apache-2.0 Agent Skills copied by the exact bootstrap plan,
  including project-type-aware organization bootstrap
- Agent-readable capability catalog with every external integration disabled
  by default
- Optional approval-gated SearXNG `web.search` with bounded network behavior
- Evidence-grounding instructions validated with a local Gemma 4 workflow
- Project-brief `kickoff` that creates the approved team, work allocation,
  copy/paste handoffs, approval matrix, files, and first triaged WorkItem
  together, with optional Codex/Claude projection in the same plan
- Exact-approved `configure-project` for saved language, approval detail, tone,
  project/role guidance, and validated organization revisions; `project-config`
  reads the current settings without changing them
- Local stdio MCP bridge with a unique non-human session actor, exact
  role/target/run fencing, governed workspace change-set requests, and no human
  approval authority
- Exact-plan Codex/Claude role and MCP projection, plus a hash-pinned Codex
  app-server AgentHost adapter with fail-closed native approval requests

This is pre-alpha software, not a production authorization system.
`human:*` authority is a Control Plane policy boundary, not cryptographic proof
of a person against a local process that can invoke the CLI or edit the
database. Keep the primary coding host away from approval credentials and make
approval decisions in a separately controlled human session. Generated child
role permissions can be overridden by a parent Codex/Claude session, so start
that parent without native write/shell authority; this is not an OS sandbox.

> Project-type teams, one-plan `kickoff --host`, and project customization use
> the `v0.0.10-alpha.1` package. A host-bound setup is complete only after the
> approved apply and the new-session MCP health check. Omit `--host` when you
> want the provider-neutral core without native-host projection.

## Requirements

- Node.js 24 or newer
- Git 2.x when installing directly from the GitHub `npx` ref
- pnpm 11 for source verification

There are no runtime npm dependencies in this slice. The GitHub `npx` form
still invokes the local Git client; a future registry or standalone-binary
release may remove that prerequisite. It also relies on npm's normal lifecycle
scripts to run the repository's dependency-free `prepare` build. Environments
that globally disable install scripts must use a reviewed prebuilt package or
source checkout instead; `ignore-scripts` GitHub installs are unsupported.

## Portable skills and free integrations

Every approved bootstrap installs these provider-neutral Agent Skills under
`.chartermesh/skills/`:

- `organization-bootstrap`
- `web-research`
- `repository-diagnostics`
- `small-model-evidence`
- `tool-grounded-implementation`
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

## Released entry and one-setup flow

On a machine with Node.js 24 or newer, a human, coding agent, or shell can run
the published friend-trial release without manually checking out this source
tree:

```powershell
npx --yes github:jade-blanco/chartermesh#v0.0.10-alpha.1 propose --target C:\path\to\project --profile balanced --json
npx --yes github:jade-blanco/chartermesh#v0.0.10-alpha.1 bootstrap --target C:\path\to\project --profile balanced --engine fake --json
```

The tag-pinned package includes project-type templates, `TEAM-CHARTER.md`,
one-plan `kickoff --host`, and `configure-project`. A Git tag is movable and is
not a cryptographic commit attestation; do not silently omit it to select `main`.

For a new project's one-setup flow, put the request in a
brief file outside the target and use `kickoff` instead of separately
bootstrapping, projecting the coding host, and creating the first task:

```powershell
$CM = "github:jade-blanco/chartermesh#v0.0.10-alpha.1"
$Target = "C:\path\to\new-project"
$Brief = "C:\path\to\project-brief.md"
New-Item -ItemType Directory -Force -Path $Target | Out-Null
npx --yes $CM kickoff `
  --target $Target `
  --brief-file $Brief `
  --team-template software-product `
  --profile controlled `
  --engine fake `
  --host codex `
  --executable-sha256 HOST_SHA256 `
  --allow-unrestricted-read `
  --json
```

The preview writes nothing. Repeat that identical command with
`--approve PLAN_HASH`; it then installs the reviewed configuration, stores the
brief, creates the selected domain-team scaffold and
`.chartermesh/TEAM-CHARTER.md`, projects the
Codex project roles and MCP bridge, and creates one triaged WorkItem with
explicit acceptance criteria. Use `--host claude` for Claude Code. Omit
`--host` when only the provider-neutral core is wanted. If a coding host does
not supply `--team-template`, kickoff still creates the sanitized `general`
team; the bundled `organization-bootstrap` skill is expected to select the
more specific template from the user's project goal.

Before a host-bound preview executes the host's version probe, it requires the
resolved executable's read-only SHA-256 as `--executable-sha256`. When omitted,
the CLI reports the observed digest and exits without starting the host; the
coding agent repeats the preview with that value. This is still one CharterMesh
approval plan, not a second CharterMesh human decision. Codex project trust or
Claude's one-time MCP permission remains a separate host UI action and cannot
approve the plan.

### Connect the project to Codex or Claude Code

The no-write `kickoff --host` preview inspects and binds the installed host
without making a model call or changing the project. For an already installed
project, the same inspection is available separately:

```powershell
npx --yes $CM host doctor `
  --host codex `
  --target $Target `
  --json
```

This reports the executable hash and a CharterMesh-declared compatibility
snapshot derived from the host kind and reported version; it is not a live
feature probe. The later approved host plan persists both. Projection-only
checks create no model turn and do not require the experimental direct
protocol. Use `host doctor --direct` only to test the exact Codex app-server
protocol used by direct execution. The post-projection MCP health check below
is therefore mandatory.

For a project that was initialized without `kickoff --host`, generate a later
exact plan. This projects the OrgSpec roles and a tag-pinned CharterMesh MCP
command into the host's project configuration:

```powershell
npx --yes $CM configure-host `
  --host codex `
  --target $Target `
  --executable-sha256 HOST_SHA256 `
  --allow-unrestricted-read `
  --max-agents 4 `
  --json
```

Repeat with `--approve PLAN_HASH`. A fresh-project `kickoff --host` already
performs this projection and does not need the second plan. Both
hosts then read and mutate the same CharterMesh Control Plane through local
stdio MCP; their native task lists are not authoritative and the MCP server
cannot perform a human approval. Projected role files deny native shell and
write tools by default, but a parent host policy can override child settings.
Start the parent without native write/shell authority. Roles request one
bounded content-addressed change set through MCP, a human reviews and approves
its exact bytes with `approve-tool`, and a newly claimed run executes only the
stored approved set while recording evidence. This default project mode does
not activate a direct host runtime target.

One project bridge serves the aggregate configured OrgSpec roles. Generated
profiles are instructed to claim only their own `ownerRole`, but a shared MCP
connection cannot authenticate the native subagent identity. Treat cross-role
separation as procedural in this alpha, not as an authorization boundary.
Kickoff creates one entry-role `operator` WorkItem. Coordinator and verifier
profiles participate through the generated copy/paste consultation packets;
they may read bounded referenced context but cannot claim or mutate the
operator's item. Give them separate role-owned WorkItems before expecting
Control Plane mutation or automatic dependency progression.

After applying either host-bound plan, close the pre-projection host session and start a
new Codex or Claude Code session from the project root. Trust the project so
Codex loads `.codex/config.toml`; in Claude Code, approve the project MCP server
once and inspect it with `/mcp`. Verify that `chartermesh_status` and
`chartermesh_work_next` are available before assigning work. A running session
is not assumed to hot-reload generated roles or MCP configuration.

The generated bridge command is tag-pinned but does not cryptographically
attest the `npx` launcher or the remote commit behind a movable Git tag. For a
higher-assurance setup, bind a reviewed local bridge command or a commit-SHA
distribution in the approved host plan.

Codex can additionally be selected as a direct execution target by including
`--activate-role operator --allow-unrestricted-read` in both the preview and
approved **`configure-host`** command after initialization. `kickoff` performs
project-role and MCP projection only and rejects `--activate-role`. The
acknowledgement is required because Codex's read-only
sandbox does not confine reads to the project directory. That path uses the
hash-pinned experimental app-server adapter and may consume the user's Codex
quota. Claude direct AgentHost execution is not implemented in this alpha;
its supported path is the projected roles plus shared MCP bridge.

Use repeated `--pass-env NAME` only when direct Codex needs a reviewed
API-key, proxy, or certificate environment variable. Values are inherited at
runtime and are never stored in the plan. Host-user ChatGPT authentication
normally needs no pass-through variable.

For a coding-agent handoff, this prompt is sufficient even for an empty
project folder:

> Use CharterMesh v0.0.10-alpha.1 from its tag-pinned GitHub package or a reviewed
> matching source checkout. Treat this message as the project brief and
> apply the `kickoff` flow to the empty project folder. Read `BOOTSTRAP.md` and
> the `organization-bootstrap` skill.
> Select the matching provider-neutral team template and a defensible profile
> (`balanced` by default; `controlled` when I explicitly want separate
> coordination, production, and verification). If you are Codex or Claude,
> include that coding host in the same kickoff plan
> with its read-only executable SHA-256 (`--host codex
> --executable-sha256 HOST_SHA256 --allow-unrestricted-read` for Codex or
> `--host claude --executable-sha256 HOST_SHA256` for Claude). If the digest is
> unknown, report it without starting the host and retry the preview. If you are
> another coding agent, omit `--host` and use the provider-neutral entrypoint
> and handoff packets. Show
> the proposed team scaffold, division of work, handoff rules, approval
> matrix, every file, and the exact plan hash. Do not write until I approve
> that same hash. After approval run `doctor`. For Codex or Claude, start a new
> trusted host session from the project root and verify the CharterMesh MCP
> tools; for another agent, verify `AGENT-ENTRYPOINT.md` and
> `TEAM-CHARTER.md`. Never treat a model review or host permission prompt as my
> CharterMesh approval.

The template/profile mapping and exact handoff packets are documented in
[`docs/TEAM-COMPOSITION.md`](docs/TEAM-COMPOSITION.md).

`kickoff` previews—and the existing-project core-only `bootstrap` preview—return
an exact plan hash and perform no target writes. After a human approves that
value, repeat the same plan-generating command with
`--approve PLAN_HASH`. The GitHub package path builds dependency-free
JavaScript before execution. Downloading the package requires network access
and should be explicitly authorized in managed agent environments.

For a one-setup trial, give a coding agent the target path and
project goal together with the single handoff prompt above.

This is a pre-alpha evaluation path. Use a disposable branch or project copy,
inspect the plan, and do not grant deployment, payment, credential, or important
data-changing authority during the first trial.

## Five-minute existing-project core start

This `bootstrap` path is for an existing project that needs the provider-neutral
core only. It does not create the goal-bound team charter or initial WorkItem.
For a new project, use the `kickoff` flow above instead; do not apply both.

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

`doctor` compares the target's pinned installation version with the running CLI
and reports any incomplete apply journal without mutating it. Inspect the
evidence, then use explicit `recover` or repeat the exact already-approved apply
command to resume it. Use
`chartermesh version --check` for an explicit network check of the latest
published GitHub release, including prereleases.

## Tailor the project after setup

A coordinating agent may propose clearer instructions or a better division of
work. It cannot approve its own proposal: inspect the current setup, preview the
candidate, and have a person approve that exact hash.

```powershell
node bin/chartermesh.mjs project-config --target TARGET --json
node bin/chartermesh.mjs configure-project --target TARGET `
  --preferences-file PREFERENCES_FILE --json
# After a person approves PLAN_HASH, repeat every option unchanged:
node bin/chartermesh.mjs configure-project --target TARGET `
  --preferences-file PREFERENCES_FILE --json --approve PLAN_HASH
```

Preferences select language (`auto|ko|en`), approval detail
(`eli5|concise|technical`), tone (`plain|formal`), and project/role instructions.
They are advisory guidance, not new permissions or model training. ELI5 is the
default; every style retains exact hashes, evidence status, risks, and unknowns.
The saved contract is `.chartermesh/preferences.json`; `PREFERENCES.md` is its
readable projection.
Decision Packet views honor language/detail preferences. Bootstrap,
configuration, and evaluation plan explanations currently remain English ELI5;
free-form guidance does not translate every fixed UI label or past artifact.

Use `--organization-file` for a complete validated OrgSpec revision that keeps
the organization ID. Active runs block changes; unfinished work must retain
valid roles and execution targets. Existing approval policy cannot be weakened,
and engine/host connections remain separate. Applied customization protects
the project against a default bootstrap overwrite. See
[`Project customization`](docs/PROJECT-CUSTOMIZATION.md) for the full contract,
existing-host re-attestation flags, and recovery limits. To refresh an installed
project for this release, use `configure-project` with no candidate files;
review and approve its plan instead of rerunning bootstrap over custom settings.

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
For Codex/Claude project roles, MCP, and the direct Codex host boundary, see
[`docs/CODING-HOSTS.md`](docs/CODING-HOSTS.md).

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

To run the narrower three-condition C-level routing canary, add
`--hybrid-c-level-canary` to both the dry plan and the approved live command:

```powershell
# Dry only: review data.planHash; no model or Codex process is started.
node bin/chartermesh.mjs evaluate-workflow --target TARGET --fixture product-package-easy-001 `
  --hybrid-c-level-canary --engine-id local-model `
  --codex-executable C:\absolute\path\to\codex.exe --codex-sha256 SHA256 `
  --codex-model CODEX_MODEL --codex-max-output-bytes 1048576 --json

# Repeat every plan-defining option exactly, then approve the returned hash.
node bin/chartermesh.mjs evaluate-workflow --target TARGET --fixture product-package-easy-001 `
  --hybrid-c-level-canary --engine-id local-model `
  --codex-executable C:\absolute\path\to\codex.exe --codex-sha256 SHA256 `
  --codex-model CODEX_MODEL --codex-max-output-bytes 1048576 `
  --live --approve PLAN_HASH --json
```

The canary compares a local single run, an all-local team, and a team whose
coordinator/C-level role alone uses the attested Codex executable. All three
receive the same host-owned orientation; specialist work and contract repair
remain on the local candidate engine. It currently accepts artifact fixtures
only: `--full`, `--code-only`, or any code fixture fails closed. Omit
`--max-total-tokens`; Codex exec usage is unmeasured, so the canary rejects a
finite total-token cap instead of pretending to guarantee it.
`--codex-max-output-bytes` is a subprocess-output safety bound, not a token or
cost cap, and is committed by the exact approval hash. Codex
`maxOutputTokens` is advisory because CLI-side hard enforcement cannot be
proven; timeout, call count, response schema, and output bytes are the hard
bounds, while Codex token/cost usage remains unknown. Hybrid results are not
compute matched; interpret `conditionComparisons` beside `engineAggregate`
calls, known token/cost fields, and elapsed time.

## Evaluate the decision-review projection

The fixed review regression compares ten fictional cases under `raw` and
`decision_review` presentations. Each presentation includes the same exact
bounded artifact, tool-call, or user-input subject; artifact cases also carry
the same separately labelled producer report. The second presentation adds
the bound Decision Packet projection. The dry command starts no Codex process:

```powershell
node bin/chartermesh.mjs evaluate-decision-review --target TARGET `
  --suite decision-review-fixed-10-v1 `
  --codex-executable C:\absolute\path\to\codex.exe `
  --codex-sha256 SHA256 --codex-model CODEX_MODEL --json
```

Review `data.planHash`, then repeat every plan-defining option and approve that
exact value to run all 20 stateless calls:

```powershell
node bin/chartermesh.mjs evaluate-decision-review --target TARGET `
  --suite decision-review-fixed-10-v1 `
  --codex-executable C:\absolute\path\to\codex.exe `
  --codex-sha256 SHA256 --codex-model CODEX_MODEL `
  --live --approve PLAN_HASH --json
```

If Codex reports quota/rate capacity exhaustion or an authentication boundary,
the run pauses after preserving its completed prefix. An operator signal is
also resumable only when it is observed between calls, before the next flushed
invocation record is created. Ctrl+C during an active model call leaves that
call's outcome unknown, so the checkpoint fails closed and cannot be resumed
automatically. The checkpoint is local at
`.chartermesh/evaluations/<benchmarkId>/checkpoint.json`; only a completed
report is written under `.chartermesh/exports/`. Plan a resume without calling
the model, declaring only whether the account context is the same, changed, or
unknown:

```powershell
node bin/chartermesh.mjs evaluate-decision-review --target TARGET `
  --suite decision-review-fixed-10-v1 `
  --codex-executable C:\absolute\path\to\codex.exe `
  --codex-sha256 SHA256 --codex-model CODEX_MODEL `
  --resume --account-context changed --json
```

Review the new resume-plan hash, then repeat the same command with
`--live --approve RESUME_PLAN_HASH`. Every resume needs its own exact approval;
the completed trial prefix is immutable, and the model, executable digest,
limits, suite, protocol, and harness-source digest must still match the base
plan. A model invocation is durably marked before it starts. A running, failed,
active, or otherwise unknown attempt is never retried automatically; only a
clean paused checkpoint can be resumed. CharterMesh stores no account name,
email, authentication path, credential, or credential hash. `account-context`
is an operator declaration, not an attestation. Every resume creates a new
execution segment and therefore prevents a strict uninterrupted
single-reviewer benefit claim; `changed` or `unknown` additionally records the
declared account-continuity uncertainty. Any benchmark source change
invalidates earlier base and resume plan hashes.

Each resumed segment binds the exact source checkpoint and prior segment chain,
and live continuation creates an exclusive used-approval receipt before the
next model process. A dead-owner stale lock is recovered only for that exact
clean paused state. State-path symlinks and junctions are rejected. These are
single-user local integrity controls, not digital signatures or protection
against a malicious local writer or whole-directory rollback.

The executable digest, model, suite, presentation order, renderer, prompt,
response schema, harness-source digest, per-call timeout, output-byte bound,
oracle commitment, and engineering thresholds are plan-bound. The reviewer
runs read-only with tools disabled and can never satisfy a production
`human:*` approval. Results are paired descriptive regression evidence for
this fixed suite and reviewer—not a human study, causal estimate, statistical
result, or autonomy claim. See
[`docs/DECISION-REVIEW-PROXY-BENCHMARK.md`](docs/DECISION-REVIEW-PROXY-BENCHMARK.md)
and
[`ADR 0021`](docs/adr/0021-artifact-report-binding-and-decision-review-benchmark.md).

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

Never pass secrets through `provide-input --response`: command-line values can
remain in shell history or process-argument listings. Prefer the local
dashboard form for sensitive but non-secret responses, and use environment
variables or a dedicated secret manager for credentials and tokens.

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
node bin/chartermesh.mjs decision-packet --id work-000001 --target TARGET --json
node bin/chartermesh.mjs approve-tool --id work-000001 --call-hash CALL_SHA256 --tool workspace.write_file --packet-hash PACKET_SHA256 --target TARGET
# Or reject without executing it:
node bin/chartermesh.mjs deny-tool --id work-000001 --call-hash CALL_SHA256 --tool workspace.write_file --packet-hash PACKET_SHA256 --target TARGET
node bin/chartermesh.mjs run --id work-000001 --target TARGET
node bin/chartermesh.mjs tool-evidence --id work-000001 --target TARGET --json
```

The unapproved call waits without changing the WorkItem to failed. Exact human
approval returns it to ready, and the next `run` uses a new fenced generation.
Exact human rejection cancels the WorkItem without executing the call and
preserves the decision evidence. Every full-content write binds the exact
current `beforeSha256` (or explicit absence), rejects nested CharterMesh/Git/
host-control paths, and applies through the recoverable file transaction. A
durable execution reservation prevents automatic replay after a crash; an
unprovable effect becomes `TOOL_OUTCOME_UNKNOWN` for human inspection.

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

Project customization also saves `.chartermesh/preferences.json`, a readable
`.chartermesh/PREFERENCES.md`, and an overwrite-protection marker. Keep the marker;
use a new approved `configure-project` plan for later changes.

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
- [`docs/DECISION-REVIEW-PROXY-BENCHMARK.md`](docs/DECISION-REVIEW-PROXY-BENCHMARK.md) — fixed raw/Decision Packet review regression
- [`docs/USAGE.md`](docs/USAGE.md) — operating workflow
- [`docs/PRODUCT-DESIGN.md`](docs/PRODUCT-DESIGN.md) — architecture source of truth
- [`SECURITY.md`](SECURITY.md) — security and vulnerability reporting

Licensed under the [Apache License 2.0](LICENSE).
