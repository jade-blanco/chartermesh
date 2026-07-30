# ADR 0015: Bundle portable skills; keep external integrations opt-in

- Status: accepted
- Date: 2026-07-30

## Context

Local agents benefit from web research, browser QA, repository inspection, and
integration-review guidance. Automatically installing popular community
skills or MCP servers would also add executable supply-chain inputs, new
package managers, network egress, credentials, overlapping file executors, and
provider-specific configuration. Popularity and zero purchase price do not
make those effects safe defaults.

CharterMesh must remain usable with any ModelEngine or AgentHost, offline and
free by default. SQLite remains the only mutable WorkItem ledger, and the
common Tool Runtime remains the execution authorization boundary.

## Decision

1. CharterMesh authors and bundles four Apache-2.0 Agent Skills using the open
   `SKILL.md` package format: web research, repository diagnostics,
   small-model evidence discipline, and integration review.
2. Exact bootstrap plans copy these packages into
   `.chartermesh/skills/` and add an `AGENT-ENTRYPOINT.md`. A model reads only
   the relevant skill; skill text never grants permission.
3. A checked-in capability catalog records the canonical source, license,
   prerequisites, network and credential needs, risks, disposition, and
   default state for selected external services and MCP servers.
4. Every external catalog entry starts disabled. CharterMesh does not run
   `npx`, `uvx`, `pip`, clone, or account-connection commands for those entries.
5. The first optional network executor is `web.search` through an
   operator-supplied SearXNG Search API endpoint. CharterMesh does not vendor
   or operate SearXNG.
6. SearXNG search accepts only HTTPS or loopback HTTP endpoints, refuses
   embedded credentials and redirects, bounds time/results/bytes, returns
   normalized HTTP(S) result metadata, and does not fetch result pages.
7. Search is absent without runtime configuration, must appear in the
   assigned OrgSpec allowlist, requires a tool-calling engine, and is treated
   as an external side effect. The exact query call must receive human Control
   Plane approval before egress.
8. Existing path-contained workspace tools are preferred over an additional
   Filesystem MCP. Git MCP is host-optional, not a task ledger. Fetch MCP and
   browser automation remain opt-in because their egress and session surfaces
   require a separate threat model.
9. The ManagedRunner prompt explicitly separates performed checks from
   proposed checks. An unevidenced inspection belongs in risks or next
   actions, not in completed checks.

## Consequences

- Clean bootstrap gains portable guidance without a provider account, paid
  API, runtime dependency, or background service.
- A local Gemma or other constrained model receives the same evidence rules as
  a hosted engine.
- Users can discover recommended integrations with versioned CLI JSON without
  installing them.
- Web search needs a separately reviewed SearXNG endpoint and exact per-query
  approval. Public-instance availability, retention, and rate limits remain
  operator concerns.
- CharterMesh still has no generic MCP client. Adding one requires protocol
  lifecycle, capability projection, approval, cancellation, evidence, and
  supply-chain designs rather than copying host configuration into the core.

## Sources considered

- Agent Skills specification: https://agentskills.io/specification
- SearXNG Search API: https://docs.searxng.org/dev/search_api.html
- MCP reference servers and production warning:
  https://github.com/modelcontextprotocol/servers
- Microsoft Playwright MCP:
  https://github.com/microsoft/playwright-mcp
