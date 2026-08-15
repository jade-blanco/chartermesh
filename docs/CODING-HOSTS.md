# Codex and Claude Code integration

CharterMesh integrates coding products as optional hosts around the same local
Control Plane. It does not copy WorkItems into a provider task list and it does
not require either product for the provider-neutral ManagedRunner path.

## Two integration modes

| Mode | Codex | Claude Code | Model/quota use |
|---|---|---|---|
| Project roles + local MCP | supported | supported | only when the user starts work in that host |
| Direct `chartermesh run` AgentHost | experimental app-server adapter | not implemented | consumes the selected host account's quota |

Project mode is the recommended friend trial. `configure-host` derives role
files from OrgSpec and adds one tag-pinned local stdio MCP entry. The MCP
server exposes fenced work execution and read surfaces under a unique
per-process non-human actor. It cannot approve a plan, tool call, artifact, or
user-input decision. Without `--activate-role`, it does not create a direct
Codex runtime target and therefore cannot consume quota through
`chartermesh run`.

Restarting the bridge creates a different actor. Any lease owned by the prior
process remains fenced to that process until it expires or is explicitly
recovered; the replacement session cannot reuse the old lease tuple.

## Fresh-project flow

```powershell
$CM = "github:jade-blanco/chartermesh#v0.0.9-alpha.1"
$Target = "C:\path\to\new-project"
New-Item -ItemType Directory -Force -Path $Target | Out-Null

# No write: inspect the kickoff plan and retain data.planHash.
npx --yes $CM kickoff --target $Target --brief-file C:\path\to\brief.md `
  --profile controlled --engine fake --json

# Repeat the identical options only after approving that exact hash.
npx --yes $CM kickoff --target $Target --brief-file C:\path\to\brief.md `
  --profile controlled --engine fake --json --approve PLAN_HASH

# No model call and no project write.
npx --yes $CM host doctor --host codex --target $Target --json

# No write: inspect the separate host projection hash.
npx --yes $CM configure-host --host codex --target $Target `
  --allow-unrestricted-read --max-agents 4 --json

# Repeat only after approving the second exact hash.
npx --yes $CM configure-host --host codex --target $Target `
  --allow-unrestricted-read --max-agents 4 --json --approve HOST_PLAN_HASH
```

Use `--host claude` for Claude Code. An explicitly installed executable can be
selected with `--executable ABSOLUTE_PATH`. The preview records its resolved
version, executable SHA-256, and CharterMesh-declared compatibility-snapshot
SHA-256. That snapshot is not a live host feature probe. Apply rechecks the
bytes, reported version, and declared snapshot; direct Codex execution
re-attests them again before process start. On Windows, an npm `.cmd` launcher
attests the wrapper plus its reported version, not every same-version byte in
the package behind that wrapper. Use a reviewed direct executable path when
that stronger boundary is required.
Projection-only `host doctor` and `configure-host` do not require the
experimental app-server protocol. `host doctor --direct` and any
`--activate-role` plan perform the initialize-only exact-version handshake; no
model turn is created. Advanced executable wrappers can supply a bounded,
plan-bound argument with repeated `--host-arg ARG`. Claude's projection-only
check requires its version output to identify Claude Code; it does not claim a
direct Claude protocol handshake.

By default the generated MCP command uses the same tag-pinned GitHub ref. A Git
tag is not cryptographically immutable, and this pre-alpha plan does not attest
the `npx` launcher or resolved remote commit bytes. Use a reviewed local command
or commit-SHA-pinned distribution when that supply-chain boundary matters. The
GitHub form also requires npm lifecycle scripts for its dependency-free
`prepare` build; an `ignore-scripts` environment needs a prebuilt package. An
operator with a reviewed local installation can instead repeat
`--bridge-command COMMAND --bridge-arg ARG` to bind a different launch command
into the host plan.

## Generated project projections

Codex:

- `.codex/agents/chartermesh-ROLE.toml`
- merged `.codex/config.toml` agent and `mcp_servers.chartermesh` settings
- a marked CharterMesh section in `AGENTS.md`

Claude Code:

- `.claude/agents/chartermesh-ROLE.md`
- merged `.mcp.json` `mcpServers.chartermesh` entry
- a marked CharterMesh section in `CLAUDE.md`

Unrelated TOML, JSON, and Markdown content is preserved. Every final byte and
its prior hash are included in the file transaction plan; malformed or
ambiguous merge targets fail before apply.

After apply, start a **new** host session from the project root. Codex must
trust the project before it loads `.codex/config.toml`. Claude Code asks for a
one-time project MCP approval; use `/mcp` to inspect it. Confirm that
`chartermesh_status` and `chartermesh_work_next` are present. The session that
created the projection may not hot-reload roles or MCP configuration. This
post-projection health gate is required because projection-only discovery does
not prove each installed host feature dynamically.

## Governed project writes

Projected role files deny native write and shell tools. Parent host permissions
can override child settings, so start the parent session without native
write/shell authority; this is a procedural pre-alpha boundary, not an OS
sandbox. A code change uses this resumable sequence instead of `Write`, `Edit`,
Bash, or PowerShell:

The project currently uses one MCP bridge containing the aggregate allowed
OrgSpec role set. Each generated profile is instructed to claim only its exact
`ownerRole`, but the bridge cannot authenticate which native subagent invoked a
shared MCP tool. Cross-role separation is therefore procedural in this alpha;
the Control Plane still fences the shared session actor, route set, run, lease,
and generation.

1. claim the WorkItem through MCP;
2. call `chartermesh_workspace_changes_request` with 1-50 exact path/content/
   `beforeSha256` entries (use `null` only when the file is absent);
3. let the prior run enter approval wait;
4. a person reviews every stored path, full content, before/after hash, and
   total size in the dashboard or `chartermesh tool-evidence --id WORK --json`;
   the Decision Packet hash alone is not a review of those bytes;
5. in a separately controlled session, run `approve-tool` for the exact call
   and packet hashes;
6. claim the ready WorkItem again; and
7. call `chartermesh_workspace_write_execute` with the new fence and approved
   call hash. The server loads the stored bytes, applies the recoverable file
   transaction, and records execution evidence.

`chartermesh_workspace_write_request` remains a one-file compatibility wrapper;
new implementation work should use the bounded change-set request.

The MCP server exposes no approval resolver. A host permission dialog does not
satisfy step 4. This alpha's `human:*` actor check is procedural rather than a
cryptographic proof against a local process with direct CLI/database access.

## Direct Codex execution

To make selected roles prefer the Codex AgentHost, repeat
`--activate-role ROLE --allow-unrestricted-read` in both the preview and
approved `configure-host` commands. The acknowledgement is necessary because
Codex's read-only sandbox can still read outside the project directory; use an
external OS sandbox as well when project-contained reads are a requirement.
Optional `--model` and `--reasoning-effort` values are passed to the host, not
treated as provider-neutral model-engine settings. Repeated `--pass-env NAME`
entries bind reviewed API-key/proxy/certificate variable names for direct
setups; values are not stored.

The adapter:

1. records a running invocation;
2. starts the pinned `codex app-server` over stdio;
3. binds CharterMesh Run/Attempt ids to Codex thread/turn ids;
4. streams bounded normalized events;
5. requires one structured artifact result;
6. submits it for normal exact-hash human review.

The cost measurement is `unknown` because a host-managed account may not
report price or usage. OrgSpec `unknownCostPolicy: block` therefore blocks the
run; `warn` allows it while retaining the unknown measurement.

Provider approval is deliberately incomplete in this alpha. A Codex native
command, file, permission, or user-input request is denied fail-closed and the
run becomes a visible failure. It is not converted into a fake CharterMesh
human approval. Roles whose workspace write tool requires CharterMesh approval
are started read-only on the direct path. Interactive project mode remains
available through the governed MCP write sequence above.

Projected role files are capability profiles, not a second authoritative team
ledger. A `controlled` profile creates operator and verifier roles, and the
primary host may invoke them, but provider-native subagent/session lineage is
not yet mirrored as child WorkItems. All authoritative assignment and result
state remains in the CharterMesh Control Plane.

## Session prompt

For an empty folder, give the coding host this message with the folder path and
your actual project requirements:

> Use https://github.com/jade-blanco/chartermesh at tag v0.0.9-alpha.1. Treat
> my requirements as the project brief and follow `BOOTSTRAP.md`. Generate a
> no-write `kickoff` plan first and show me its exact hash and all files. Apply
> only after I approve that same hash. Then run `doctor`, inspect your host with
> `host doctor`, generate a separate `configure-host` plan, and again wait for
> my exact hash approval. Use the projected roles and CharterMesh MCP for work
> state. Never treat your own review, a subagent response, or a host permission
> prompt as my approval.

That prompt authorizes inspection and plan generation. The two plan hashes are
still distinct human decisions.
