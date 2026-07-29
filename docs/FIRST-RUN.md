# First run

This guide starts with the offline fake engine, verifies the complete local
path, and then shows where to configure a live model.

## 1. Prepare CharterMesh

Clone the public repository and verify the source:

```powershell
git clone CHARTERMESH_REPOSITORY_URL chartermesh
cd chartermesh
node --version
pnpm verify
```

Node.js 24 or newer is required. The current runtime has no external npm
dependencies.

If you are using a coding agent, give it the repository URL and say:

> Apply CharterMesh to this project.

The agent must follow `BOOTSTRAP.md`; it should not improvise target files.

## 2. Preview the target plan

From the CharterMesh checkout:

```powershell
node bin/chartermesh.mjs bootstrap --target C:\path\to\target --engine fake
```

The preview:

- reads the target;
- calculates before and after hashes;
- lists the proposed `.chartermesh` files;
- prints one plan hash;
- performs no target writes.

Review the target and hashes. Then repeat the same command with the exact
approval token:

```powershell
node bin/chartermesh.mjs bootstrap --target C:\path\to\target --engine fake --approve PLAN_HASH
```

If the target changed after preview, the hash changes and the old approval is
rejected.

## 3. Diagnose and seed offline work

```powershell
node bin/chartermesh.mjs doctor --target C:\path\to\target
node bin/chartermesh.mjs seed-demo --target C:\path\to\target
node bin/chartermesh.mjs list --target C:\path\to\target
```

`doctor` validates configuration only. It deliberately does not make a paid or
remote model call.

## 4. Start the local dashboard

```powershell
node bin/chartermesh.mjs dashboard --target C:\path\to\target
```

Open the printed `http://127.0.0.1:PORT` URL. The server:

- binds to loopback only;
- checks Host and mutation Origin;
- requires a per-process browser session token for mutations;
- returns no database, artifact, credential, or target paths.

The pre-alpha dashboard creates and inspects requests. Use the CLI for triage,
run, review, and completion.

## 5. Reconfigure the engine

Reconfiguration uses its own plan and approval hash. For example:

```powershell
node bin/chartermesh.mjs configure-engine `
  --target C:\path\to\target `
  --engine openai-compatible `
  --endpoint http://127.0.0.1:11434/v1 `
  --model YOUR_MODEL_ID
```

Review the runtime-file before/after hashes, then repeat the identical command
with `--approve PLAN_HASH`.

See `LLM-CONNECTIONS.md` for tested protocol shapes and security guidance.

## 6. Remove local runtime state

CharterMesh does not provide a destructive uninstall command in pre-alpha.
Desired configuration is in `.chartermesh/organization.json` and
`.chartermesh/runtime.json`; mutable state and artifacts are ignored by the
target's nested `.gitignore`.

If removal is needed, stop the dashboard, back up anything that must be
retained, and have a human explicitly approve the exact `.chartermesh`
directory before deleting it. Removing that directory permanently removes the
local WorkItem ledger and review artifacts.
