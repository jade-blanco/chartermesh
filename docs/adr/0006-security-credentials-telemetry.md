# ADR 0006: Run-scoped identity and privacy-minimal telemetry

- Status: accepted in design; implementation pending
- Date: 2026-07-27

## Decision

Human users authenticate to the loopback service with expiring local sessions.
Workers receive short-lived credentials bound to organization revision, Run,
Actor, Role, generation, scope, and expiry. Provider plugins never receive a
long-lived administrator token.

Usage telemetry is local and required for governance, but raw conversation
capture is disabled by default. Unknown token or cost values remain `unknown`;
they are never silently recorded as zero. Secret redaction runs before logs,
events, and errors are persisted.
