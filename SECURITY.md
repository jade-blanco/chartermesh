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
- Loopback-only dashboard with Host, Origin, JSON media-type, body-size, and
  per-process session-token checks
- Generation fencing for runner artifact submission
- Human review bound to the exact immutable artifact hash

The current OpenAI-compatible adapter performs opt-in inference only. It has no
tool execution or external-side-effect authority. The threat model must be
expanded before a daemon, AgentHost, or tool-capable runner can perform
unattended mutations.
