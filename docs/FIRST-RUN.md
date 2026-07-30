# First run

This guide starts offline, applies an exact approved plan, exercises the whole
review loop, and only then connects a live model.

## 1. Prepare CharterMesh

GitHub package path, with no manual source checkout:

```powershell
npx --yes github:jade-blanco/chartermesh version --json
npx --yes github:jade-blanco/chartermesh propose `
  --target C:\path\to\target `
  --profile balanced
```

This requires an explicitly authorized package download. For source
development:

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

The approved bootstrap also installs four Apache-2.0 portable skills and
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
The apply journal survives process termination. `doctor` and the next plan
command automatically recover an incomplete replacement; `recover` is also
available as an explicit diagnostic command.

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
