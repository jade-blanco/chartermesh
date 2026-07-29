# First run

This guide starts offline, applies an exact approved plan, exercises the whole
review loop, and only then connects a live model.

## 1. Prepare CharterMesh

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

## 4. Diagnose and exercise the offline workflow

```powershell
node bin/chartermesh.mjs doctor --target C:\path\to\target
node bin/chartermesh.mjs seed-demo --target C:\path\to\target
node bin/chartermesh.mjs dashboard --target C:\path\to\target
```

The dashboard can triage, run, retry, inspect the exact artifact and SHA-256,
approve or request changes, and complete work. It binds only to loopback. All
API reads require the per-process browser session token; mutations additionally
require same-origin JSON and an idempotency key.

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

## 6. Run the synthetic model evaluation

```powershell
node bin/chartermesh.mjs evaluate-model `
  --target C:\path\to\target `
  --live `
  --json
```

The `--live` flag is an explicit model-call opt-in. The evaluation uses
synthetic prompts only. See `MODEL-EVALUATION.md`.

## Removal

There is no destructive uninstall command. Stop the dashboard, retain any
required evidence, and have a human explicitly approve deletion of the exact
target `.chartermesh` directory. Removing it permanently removes the local
ledger and artifacts.
