# ADR 0011: Safe Tool Runtime, recoverable apply, and package distribution

- Status: accepted
- Date: 2026-07-29

## Context

The model adapter could transport tool calls, but CharterMesh had no common
executor. Bootstrap staging rolled back JavaScript exceptions but could not
repair a process terminated between file renames. Applying from a repository
URL also required a source checkout because Node does not strip TypeScript
inside installed `node_modules`.

These gaps prevented the promised provider-neutral workflow from being a
reliable authorization and installation boundary.

## Decision

### Common Tool Runtime

The built-in ManagedRunner owns a provider-neutral tool loop. Model engines
only transport messages and tool calls.

Each role's OrgSpec tool policy declares:

- `allow`: exact tool names;
- `approvalRequired`: allowed tools requiring human approval;
- `workspaceRoots`: project-relative containment roots;
- `maxIterations`: a hard bound from 1 through 12.

For v1alpha1 compatibility, omitted roots and iteration limits resolve to the
project root and four iterations. Newly generated OrgSpecs always write both
values explicitly.

Workspace writes always require approval even if a malformed runtime caller
omits them from `approvalRequired`. The canonical SHA-256 call hash binds
WorkItem id, tool name, and normalized JSON arguments. Only a `human:*` Control
Plane actor may approve it.

Tool evidence stores the call, input, and output hashes, status, bounded
relative paths, duration, and attempt references. Raw arguments and results are
not copied into tool evidence or the audit projection. Exact proposed/approved
workspace bytes are retained locally in pending approval state so a new fenced
run can apply the same reviewed content after approval.

The initial tools are non-recursive directory listing, bounded UTF-8 file
reading, and bounded approval-gated UTF-8 file writing. Every content write
binds the exact prior SHA-256 or explicit absence, denies control paths, and
uses the recoverable file transaction rather than direct truncation. Durable
reservation and settlement prevent automatic replay when an execution outcome
cannot be proven. Shell, network, package-manager, deployment, and arbitrary
plugin execution remain absent.

### Recoverable file transactions

Every managed bootstrap replacement is protected by an atomic per-target lock.
All next files and an immutable journal are durably written before the first
target rename. A durable `COMMITTED` marker is written only after every target
contains its approved hash.

Recovery infers the safe action from the journal, marker, file hashes, and
backups:

- without `COMMITTED`, restore the exact pre-apply state;
- with `COMMITTED`, verify all approved hashes and finalize cleanup;
- on an external hash conflict, preserve the journal and stop.

No-write planning and diagnostics report a journal or lock without mutating
it. The explicit `recover` command performs general recovery; resuming the
exact already-approved apply operation may recover only its bound transaction.

### Distribution

The repository remains dependency-free at runtime. A build script uses the
Node 24 built-in TypeScript transform to create JavaScript under ignored
`dist/`, rewrites local `.ts` imports to `.js`, and copies required schemas and
dashboard assets.

The npm manifest packages only the built JavaScript, executable, license, and
operator documents. Git dependencies run `prepare`, so
`npx --yes github:jade-blanco/chartermesh` works without a manual checkout.
Registry publication remains a separate explicitly authorized action.

`doctor` automatically compares the target installation pin with the running
CLI without network access. `version --check` is the explicit network operation
for the latest GitHub release.

## Consequences

- Any compatible engine receives the same policy and evidence boundary.
- Approval-required calls durably pause the current Run and Attempt, release
  their lease, and keep the WorkItem in progress without marking it failed.
  Exact approval closes that waiting execution and returns the WorkItem to
  ready; the next `run` creates a new fenced generation. In-memory model
  continuation is not promised.
- Tool output needed by a model remains bounded and ephemeral.
- Apply recovery is conservative and stops on evidence of external edits.
- Node.js 24 or newer is required both for source execution and package build.
- Package readiness does not authorize npm publication or a GitHub release.

## Verification

- Tool Runtime tests cover allowed read, exact write approval, path traversal,
  evidence, and iteration exhaustion.
- A forced child-process exit after a file rename is recovered to the exact
  prior state; CLI `doctor` reports the pending journal and explicit `recover`
  exercises recovery without making a no-write diagnostic mutating.
- Sixteen-process tests cover contested claim and duplicate idempotency keys.
- A held SQLite writer verifies busy-timeout behavior.
- `pnpm pack:check` installs the tarball into a temporary consumer and performs
  version, proposal, bootstrap, and doctor checks.
