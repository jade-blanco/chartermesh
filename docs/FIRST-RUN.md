# First run

This guide starts offline, applies an exact approved plan, exercises the whole
review loop, and only then connects a live model.

For an integrated Korean guide covering installation, dashboard state,
approvals, model connection, operations, and troubleshooting, see
[`USER-GUIDE.ko.md`](USER-GUIDE.ko.md).

## 1. Prepare CharterMesh

GitHub package path, with no manual source checkout:

```powershell
npx --yes github:jade-blanco/chartermesh#v0.0.9-alpha.1 version --json
npx --yes github:jade-blanco/chartermesh#v0.0.9-alpha.1 propose `
  --target C:\path\to\target `
  --profile balanced
```

The tag selects this guide's pre-alpha friend-trial version, but a Git tag is
movable and is not a cryptographic commit attestation. Omit `#v0.0.9-alpha.1`
only when intentionally testing the latest `main` branch.

This requires an explicitly authorized package download, Git 2.x, and normal
npm lifecycle scripts so the dependency-free `prepare` build can run. An
environment that enforces `ignore-scripts` must use a reviewed prebuilt package
or source checkout. For source development:

```powershell
git clone https://github.com/jade-blanco/chartermesh.git chartermesh
cd chartermesh
node --version
pnpm verify
```

Node.js 24 or newer is required. No runtime npm dependency is needed.

With a coding agent, provide the repository URL and say:

> Apply CharterMesh to this project.

The agent must follow `BOOTSTRAP.md` and use the repository CLI.

The approved bootstrap also installs five Apache-2.0 portable skills—
`web-research`, `repository-diagnostics`, `small-model-evidence`,
`tool-grounded-implementation`, and `integration-review`—plus
`.chartermesh/AGENT-ENTRYPOINT.md`. Inspect them without model or network use:

```powershell
node bin/chartermesh.mjs skills list --json
node bin/chartermesh.mjs capabilities recommend --json
```

## 2. Inspect the proposed organization

```powershell
node bin/chartermesh.mjs propose `
  --target C:\path\to\target `
  --profile balanced
```

`propose` reads filenames and directory metadata only. It detects language,
package manager, tests, CI, and deployment/infrastructure signals. It does not
write to the target.

Profiles:

- `lean`: one worker and conservative budgets.
- `balanced`: one worker with moderate local budgets.
- `controlled`: worker plus verifier and a separate verification stage.

## 3. Preview and approve the exact plan

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

For a brand-new folder, `kickoff` combines bootstrap and the first requested
WorkItem. The target directory must already exist; create it before the
no-write preview. Put the intended service or product in a brief file:

```powershell
$Target = "C:\path\to\new-project"
New-Item -ItemType Directory -Force -Path $Target | Out-Null
npx --yes github:jade-blanco/chartermesh#v0.0.9-alpha.1 kickoff `
  --target $Target `
  --brief-file C:\path\to\project-brief.md `
  --profile controlled `
  --engine fake `
  --acceptance "The implementation satisfies the approved brief and reports verification evidence." `
  --json
```

Review the no-write response, then repeat every option and append
`--approve PLAN_HASH`. The apply stores the immutable brief and creates one
ready `operator` WorkItem; team setup is not counted as a model call. Use
`controlled` when the trial should project both operator and verifier roles;
`balanced` intentionally creates only one operator.

### Project the team into Codex or Claude Code

The host check starts no model call:

```powershell
npx --yes github:jade-blanco/chartermesh#v0.0.9-alpha.1 host doctor `
  --host codex --target C:\path\to\new-project --json
```

Generate and separately approve the host projection:

```powershell
npx --yes github:jade-blanco/chartermesh#v0.0.9-alpha.1 configure-host `
  --host codex --target C:\path\to\new-project `
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

For Codex only, repeat `--activate-role operator` in the preview and approved
command if `chartermesh run` should
invoke the experimental app-server adapter. The
`--allow-unrestricted-read` acknowledgement already present in the host plan
records that
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

## Removal

There is no destructive uninstall command. Stop the dashboard, retain any
required evidence, and have a human explicitly approve deletion of the exact
target `.chartermesh` directory. Removing it permanently removes the local
ledger and artifacts.
