# ADR 0004: One application service behind CLI, MCP, and REST

- Status: accepted in design; implementation pending
- Date: 2026-07-27

## Decision

CLI, MCP, and REST are transport adapters around one application service. No
transport may bypass authentication, idempotency, expected-version checks,
approval hash binding, or event recording.

Provider adapters are outbound ports. Plugins and skills package user-facing
workflows, while SDK, app-server, CLI, or MCP drivers perform runtime control.
A plugin being installed does not imply a programmatic runtime or schedule API
exists.
