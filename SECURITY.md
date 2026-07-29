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
- Human review bound to the exact immutable artifact hash
- OrgSpec tool allowlists, project-relative workspace roots, symbolic-link
  rejection, and hard iteration bounds
- Exact-call human approval for every built-in workspace write
- Tool evidence stores hashes and bounded relative paths rather than raw tool
  arguments or results
- Journaled bootstrap replacement with hash-directed crash recovery
- Per-artifact and per-work-item evidence size limits
- Allowlisted JSONL audit export that drops unknown payload fields
- Hashed, integrity-checked SQLite plus content-addressed artifact backup and
  maintenance-locked exact-plan approved restore
- Shell-free command-process engines with absolute, SHA-256-pinned
  executables, bounded output, timeouts, dedicated working directories, and
  explicit environment allowlists
- Redirect-disabled, size-bounded OpenAI-compatible HTTP responses

The OpenAI-compatible adapter transports model messages and tool calls but
does not execute them. The common Tool Runtime is the authorization boundary.
Its initial executors are bounded workspace list/read/write operations; there
is no shell, network, package-manager, deployment, or external-side-effect
tool. The threat model must be expanded before adding any such executor,
daemon, or unattended AgentHost mutation.

Executable hash pinning and a dedicated cwd detect replacement and reduce
accidental project access; they are not an operating-system sandbox. Only
configure a command-process executable that the operator trusts.
