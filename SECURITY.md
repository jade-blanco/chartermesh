# Security policy

This project is pre-alpha. Do not use it as a production authorization system
or grant it unattended external-side-effect permissions.

## Report a vulnerability

Use the repository's **Security → Report a vulnerability** flow to submit a
private report. If that flow is unavailable, open only a minimal public issue
asking for a private contact channel; include no exploit details, credentials,
private paths, or user data.

## Security defaults

- Local, single-user, loopback-only control plane
- Deny-by-default tools and network access
- Immutable hash binding for specs, plans, artifacts, and approvals
- Short-lived, run-scoped worker identity
- No credentials in OrgSpec, prompts, logs, events, or artifacts
- No provider-native task, permission prompt, or model review may replace a
  required human approval
- No external provider call in the default test suite
- Loopback-only dashboard with Host, Origin, JSON media-type, body-size,
  per-process session-token, and request-rate checks
- Generation fencing for runner artifact submission
- Human decisions bound to the exact immutable Decision Packet hash. For an
  artifact review, that packet separately binds the artifact bytes and media
  type, producer-report hash, evidence-set hash, WorkItem version, and
  projection version.
- OrgSpec tool allowlists, project-relative workspace roots, symbolic-link
  rejection, and hard iteration bounds
- Exact-call human approval, exact prior-state hash or absence, recoverable
  transaction, and durable execution reservation for every built-in workspace
  write
- Tool evidence and audit projections store hashes and bounded relative paths
  rather than raw tool arguments or results. Exact proposed/approved workspace
  bytes are stored locally in pending approval state so a later fenced process
  can apply precisely what the person reviewed.
- Journaled bootstrap replacement with hash-directed crash recovery
- Per-artifact and per-work-item evidence size limits
- Allowlisted JSONL audit export that drops unknown payload fields
- Hashed, integrity-checked SQLite plus content-addressed artifact backup and
  maintenance-locked exact-plan approved restore
- Shell-free command-process engines with absolute, SHA-256-pinned
  executables, bounded output, timeouts, dedicated working directories, and
  explicit environment allowlists
- Redirect-disabled, size-bounded OpenAI-compatible HTTP responses
- External skills and MCP catalog entries disabled and uninstalled by default
- Optional SearXNG search restricted to HTTPS/loopback, without endpoint
  credentials or redirects, with bounded time/results/bytes and exact-query
  approval before egress

The OpenAI-compatible adapter transports model messages and tool calls but
does not execute them. The common Tool Runtime is the authorization boundary.
Its always-available executors are bounded workspace list/read/write
operations. The only optional network executor is SearXNG result search; it is
absent unless configured and every exact query requires human approval. There
is no generic URL fetch, shell, package-manager, deployment, or unattended
external-side-effect tool. The threat model must be expanded before adding any
such executor, daemon, or unattended AgentHost mutation.

The local filesystem controls reduce accidental and stale-path corruption;
they do not defend against another malicious local process that can race path
components during a write, replace the database, or roll back the whole
project directory. Use operating-system isolation and separately controlled
approval credentials when that adversary is in scope.

Bundled Agent Skills are instruction text, not trusted executables or
permissions. External MCP packages in the catalog are metadata only. Review
their source, license, version/integrity, paths, credentials, network reach,
and removal path before a separately approved installation.

Executable hash pinning and a dedicated cwd detect replacement and reduce
accidental project access; they are not an operating-system sandbox. Only
configure a command-process executable that the operator trusts.
