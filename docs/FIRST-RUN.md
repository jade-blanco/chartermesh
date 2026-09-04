# First run

This guide starts offline, applies an exact approved plan, exercises the whole
review loop, and only then connects a live model.

For an integrated Korean guide covering installation, dashboard state,
approvals, model connection, operations, and troubleshooting, see
[`USER-GUIDE.ko.md`](USER-GUIDE.ko.md).

> This guide uses `v0.0.10-alpha.1`, including project-type teams, one-plan
> `kickoff --host`, and reviewed project customization. A source checkout is
> optional. Host-bound setup requires approved apply and a passing MCP check
> from a new host session; omit `--host` for a provider-neutral core trial.

## 1. Prepare CharterMesh

GitHub package path, with no manual source checkout:

```powershell
npx --yes github:jade-blanco/chartermesh#v0.0.10-alpha.1 version --json
npx --yes github:jade-blanco/chartermesh#v0.0.10-alpha.1 propose `
  --target C:\path\to\target `
  --profile balanced
```

The tag selects this prerelease, but a Git tag is movable and is not a
cryptographic commit attestation. Do not silently omit the tag to select `main`.

This requires an explicitly authorized package download, Git 2.x, and normal
npm lifecycle scripts so the dependency-free `prepare` build can run. An
environment that enforces `ignore-scripts` must use a reviewed prebuilt package
or source checkout. For source development:

```powershell
git clone https://github.com/jade-blanco/chartermesh.git chartermesh
cd chartermesh
git checkout v0.0.10-alpha.1
node --version
pnpm verify
```

Node.js 24 or newer is required. No runtime npm dependency is needed.

With a coding agent, provide the target path, the repository URL/ref (or a
reviewed matching checkout), and your actual project goal, then say:

> Use CharterMesh v0.0.10-alpha.1. Treat my goal as the project brief.
> Follow `BOOTSTRAP.md` and
> the `organization-bootstrap` skill, select the matching team template and a
> defensible profile, and generate one no-write `kickoff` plan containing the
> team, work allocation, handoffs, approval rules, and first WorkItem. If you
> are Codex or Claude, include that host; otherwise omit `--host` and use the
> provider-neutral entrypoint and handoff packets. Show the exact plan hash and
> do not write until I approve that hash.

The agent must follow `BOOTSTRAP.md` and use the repository CLI.

The approved bootstrap also installs six Apache-2.0 portable skills—
`organization-bootstrap`, `web-research`, `repository-diagnostics`, `small-model-evidence`,
`tool-grounded-implementation`, and `integration-review`—plus
`.chartermesh/AGENT-ENTRYPOINT.md`. Inspect them without model or network use:

The examples below use the source command `node bin/chartermesh.mjs`. Without a
checkout, replace that prefix with
`npx --yes github:jade-blanco/chartermesh#v0.0.10-alpha.1`; all command options
stay the same. The initial package download requires network access; the
installed offline inspection commands do not call a model.

```powershell
node bin/chartermesh.mjs skills list --json
node bin/chartermesh.mjs capabilities recommend --json
```

## 2. Inspect the proposed organization

```powershell
node bin/chartermesh.mjs propose `
  --target C:\path\to\target `
  --team-template software-product `
  --profile balanced
```

`propose` reads filenames and directory metadata only. It detects language,
package manager, tests, CI, and deployment/infrastructure signals. It does not
write to the target.

Team templates describe the work domain: `general`, `software-product`,
`research`, `content-production`, `data-analysis`, and `operations`. Profiles
describe role separation:

- `lean`: one domain operator and conservative budgets.
- `balanced`: coordinator plus domain operator.
- `controlled`: coordinator, domain operator, and independent verifier.

## 3. Preview and approve the exact plan

> **Choose one path:** for a new or empty project with a goal, skip the
> `bootstrap` commands immediately below and use **Start from an empty project
> brief**. The `bootstrap` path is retained for an existing project that needs
> only the provider-neutral core; it does not create the goal-bound team
> charter and initial WorkItem.

```powershell
node bin/chartermesh.mjs bootstrap `
  --target C:\path\to\target `
  --profile balanced `
  --engine fake
```

The command lists every file, its current hash or absence, its proposed hash,
and one plan hash. It performs no target writes.

After review, repeat the identical command with the exact token:

```powershell
node bin/chartermesh.mjs bootstrap `
  --target C:\path\to\target `
  --profile balanced `
  --engine fake `
  --approve PLAN_HASH
```

Changed target state produces a new hash and invalidates the old approval.
The apply journal survives process termination. `doctor` and no-write plan
commands report an incomplete replacement without mutating it. Use explicit
`recover`, or resume the exact approved apply operation, after inspection.

### Start from an empty project brief

For a brand-new folder, `kickoff` combines bootstrap, team setup, optional host
projection, and the first requested WorkItem. The target directory must already
exist; create it before the no-write preview. Put the intended service or
product in a brief file outside the target. If a host-bound preview is first
run without `--executable-sha256`, the CLI reports the observed digest and exits
without starting the host. Repeat the preview with that value as `HOST_SHA256`;
this read-only preflight does not create a second CharterMesh approval. Codex
project trust or Claude's one-time MCP permission remains a separate host UI
action and does not approve the plan:

```powershell
$CM = "C:\path\to\chartermesh\bin\chartermesh.mjs"
$Target = "C:\path\to\new-project"
$Brief = "C:\path\to\project-brief.md"
New-Item -ItemType Directory -Force -Path $Target | Out-Null
node $CM kickoff `
  --target $Target `
  --brief-file $Brief `
  --team-template software-product `
  --profile controlled `
  --engine fake `
  --host codex `
  --executable-sha256 HOST_SHA256 `
  --allow-unrestricted-read `
  --acceptance "The implementation satisfies the approved brief and reports verification evidence." `
  --json
```

Review the no-write response, then repeat every option and append
`--approve PLAN_HASH`. The apply stores the immutable brief and creates one
ready `operator` WorkItem; team setup is not counted as a model call. Use
`controlled` when the trial should separate coordinator, operator, and
verifier. The same approved plan writes `.chartermesh/TEAM-CHARTER.md` and,
when `--host` is supplied, projects the host roles and MCP bridge. Omit
`--host` for a core-only installation. A missing `--team-template` safely
falls back to the general team.

The first Control Plane WorkItem remains owned by `operator`. Coordinator and
verifier stages use the charter's bounded copy/paste consultation packets in
this release; they do not become separate claimable WorkItems merely because
host role files exist. Assign a separate role-owned WorkItem before allowing a
consulting role to mutate Control Plane state.

### Project the team into Codex or Claude Code

The host check starts no model call:

```powershell
node $CM host doctor `
  --host codex --target $Target --json
```

If the project was kicked off without `--host`, generate and separately
approve the later host projection:

```powershell
node $CM configure-host `
  --host codex --target $Target `
  --executable-sha256 HOST_SHA256 `
  --allow-unrestricted-read --max-agents 4 --json
```

This creates project-local Codex roles and MCP configuration without making
Codex's task list authoritative. Use `--host claude` for Claude Code. Both use
the same local Control Plane through MCP, and that MCP server has no human
approval authority. The projection-only host check reports the executable and
CharterMesh-declared compatibility hash without starting Codex app-server; it
is not a live feature probe. Use `host doctor --direct` only for strict
direct-protocol compatibility.

After approving and applying the host plan, close the current host session and
start a new one from the project root. Trust the project so Codex loads
`.codex/config.toml`. For Claude Code, approve the project MCP server once and
inspect it with `/mcp`. Verify `chartermesh_status` and
`chartermesh_work_next`; this post-projection health gate is mandatory, and
pre-projection sessions are not assumed to hot-reload.

Projected roles have native shell/write tools disabled. To implement, they
submit one bounded content-addressed change set through MCP. A person reviews
and approves its exact Decision Packet with `approve-tool`; a new claim then
applies only the stored approved bytes through a recoverable transaction and
records evidence. The MCP server cannot approve its own change set.

For Codex only, direct `chartermesh run` execution is a later, optional
`configure-host` change. Preview and separately approve a `configure-host`
plan containing `--activate-role operator --allow-unrestricted-read` if the
experimental app-server adapter should be enabled. `kickoff` intentionally
rejects `--activate-role`; its one-plan host path provides project roles and MCP
only. The acknowledgement records that
Codex's read-only sandbox does not confine reads to the project directory.
That path can consume the user's Codex quota. A role whose writes require
CharterMesh approval remains read-only because provider permission prompts are
currently canceled fail-closed. Claude direct AgentHost execution is not part
of this alpha.

The `human:*` check is a policy/procedural boundary, not cryptographic proof
against a local process that can invoke the CLI or edit SQLite. Keep approval
decisions in a separately controlled human session.

## 4. Diagnose and exercise the offline workflow

```powershell
node bin/chartermesh.mjs doctor --target C:\path\to\target
node bin/chartermesh.mjs seed-demo --target C:\path\to\target
node bin/chartermesh.mjs dashboard --target C:\path\to\target
```

The dashboard can triage, run, retry, inspect the exact artifact and SHA-256,
approve or request changes, and complete work. It binds only to loopback. All
API reads require the per-process browser session token; mutations additionally
require same-origin JSON and an idempotency key. General API, mutation, and
model-run request rates are bounded independently.

`doctor` validates all of `runtime.json` against the checked-in runtime schema,
then checks adapter-specific settings and references. A hand-edited unknown
field, invalid value, duplicate id, or dangling runner reference is reported
before a model process or HTTP request can start.

## 5. Configure a live engine

```powershell
node bin/chartermesh.mjs configure-engine `
  --target C:\path\to\target `
  --engine openai-compatible `
  --endpoint http://127.0.0.1:8080/v1 `
  --model YOUR_MODEL_ID `
  --structured-output prompt `
  --reasoning disabled
```

Review and approve the new plan hash, then run `doctor` again. Use
`--structured-output json-schema` only if the serving engine supports the
OpenAI JSON Schema response-format extension.

Add `--tool-calling` only when the engine implements OpenAI-style function
calls. The common Tool Runtime still exposes only tools allowed by the
assigned OrgSpec role. It confines paths to `workspaceRoots`, requires exact
human approval for writes, records hash-only evidence, and stops at
`maxIterations`.

To add free provider-neutral search, run the same engine plan with a reviewed
SearXNG `/search` endpoint:

```powershell
node bin/chartermesh.mjs configure-engine `
  --target C:\path\to\target `
  --engine openai-compatible `
  --endpoint http://127.0.0.1:8080/v1 `
  --model YOUR_MODEL_ID `
  --tool-calling `
  --web-search-searxng http://127.0.0.1:8888/search
```

SearXNG itself is not installed by CharterMesh. Search stays disabled without
this option, and every exact query requires a separate Control Plane tool-call
approval before network egress.

For a local runtime wrapper with no compatible HTTP endpoint:

```powershell
node bin/chartermesh.mjs configure-engine `
  --target C:\path\to\target `
  --engine command-process `
  --command C:\absolute\path\to\engine.exe `
  --command-arg --chartermesh-json `
  --pass-env LOCAL_MODEL_HOME
```

The process must implement the neutral JSON contract in
`LLM-CONNECTIONS.md`. No shell is used and the full parent environment is not
inherited. The approved plan pins the executable SHA-256 and execution uses an
ignored per-engine cwd. If that executable is upgraded, approve a new
`configure-engine` plan before running it again.

Before paid use, review `organization.json` and choose
`unknownCostPolicy: warn|block|estimate`. For `estimate`, configure both
`--input-price-per-million` and `--output-price-per-million`; these are the
operator's model/account prices, not CharterMesh pricing.

## 6. Run the synthetic model evaluation

```powershell
node bin/chartermesh.mjs evaluate-model `
  --target C:\path\to\target `
  --live `
  --json
```

The `--live` flag is an explicit model-call opt-in. The evaluation uses
synthetic prompts only. See `MODEL-EVALUATION.md`.

## 7. Optional operations

These controls are local and disabled or inactive until explicitly used:

```powershell
node bin/chartermesh.mjs cancel --id work-000001 --target C:\path\to\target
node bin/chartermesh.mjs list --target C:\path\to\target --active-only --limit 100 --json
node bin/chartermesh.mjs outbox list --target C:\path\to\target --dead-letters --json
node bin/chartermesh.mjs scheduler tick --target C:\path\to\target --json
```

The default organization contains no schedules. An active local controller
schedule checks the queue before model inference and records an empty tick
without a model start. See `USAGE.md` before enabling a watcher.

## Refresh an installed project

Do not rerun bootstrap to reset a customized project. Inspect its settings,
then preview a `configure-project` refresh that keeps the organization,
preferences, and unrelated user-written guide text:

```powershell
node bin/chartermesh.mjs project-config --target C:\path\to\target --json
node bin/chartermesh.mjs configure-project --target C:\path\to\target --json
```

After a person approves the returned hash, repeat the second command with
`--approve PLAN_HASH`. This can refresh installation/version references and
managed guidance without replacing the team with a default template. Supply
candidate files only when you intend to change the organization or preferences;
see [Project customization](PROJECT-CUSTOMIZATION.md) for those boundaries.
Organization changes require a new MCP/dashboard session before mutations can
continue. Read-only inspection remains available.

## Removal

There is no destructive uninstall command. Stop the dashboard, retain any
required evidence, and have a human explicitly approve deletion of the exact
target `.chartermesh` directory. Removing it permanently removes the local
ledger and artifacts.
