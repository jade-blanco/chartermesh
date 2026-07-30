export type CapabilityCatalogKind =
  | "builtin_skill"
  | "builtin_tool"
  | "optional_service"
  | "optional_mcp";

export type CapabilityDisposition =
  | "built_in"
  | "opt_in"
  | "use_host_native_first"
  | "not_recommended_by_default";

export interface CapabilityCatalogEntry {
  id: string;
  name: string;
  kind: CapabilityCatalogKind;
  disposition: CapabilityDisposition;
  capabilities: string[];
  license: string;
  source: string;
  network: boolean;
  credentials: boolean;
  defaultEnabled: boolean;
  prerequisites: string[];
  rationale: string;
  risks: string[];
}

export const capabilityCatalog: readonly CapabilityCatalogEntry[] = [
  {
    id: "portable-agent-skills",
    name: "CharterMesh portable Agent Skills",
    kind: "builtin_skill",
    disposition: "built_in",
    capabilities: [
      "web.research.method",
      "repository.diagnostics",
      "model.evidence_discipline",
      "integration.review",
    ],
    license: "Apache-2.0",
    source: "https://github.com/jade-blanco/chartermesh/tree/main/skills",
    network: false,
    credentials: false,
    defaultEnabled: true,
    prerequisites: [],
    rationale:
      "Portable instructions improve evidence quality without a provider SDK or executable dependency.",
    risks: [
      "A skill is guidance, not a permission boundary; OrgSpec and the Tool Runtime remain authoritative.",
    ],
  },
  {
    id: "searxng-web-search",
    name: "Bounded SearXNG web search",
    kind: "optional_service",
    disposition: "opt_in",
    capabilities: ["web.search"],
    license: "AGPL-3.0-or-later service; CharterMesh adapter is Apache-2.0",
    source: "https://docs.searxng.org/dev/search_api.html",
    network: true,
    credentials: false,
    defaultEnabled: false,
    prerequisites: [
      "A reviewed HTTPS or loopback HTTP SearXNG /search endpoint with JSON enabled.",
      "A tool-calling model engine for ManagedRunner use.",
      "Exact approval of each external search call.",
    ],
    rationale:
      "Adds free, provider-neutral search without requiring a commercial search API or vendoring SearXNG.",
    risks: [
      "Search queries leave the local machine.",
      "Public instances may disable JSON or apply their own retention and rate policies.",
    ],
  },
  {
    id: "mcp-fetch-reference",
    name: "MCP reference Fetch server",
    kind: "optional_mcp",
    disposition: "not_recommended_by_default",
    capabilities: ["web.fetch"],
    license: "MIT",
    source:
      "https://github.com/modelcontextprotocol/servers/tree/main/src/fetch",
    network: true,
    credentials: false,
    defaultEnabled: false,
    prerequisites: [
      "An MCP-capable AgentHost.",
      "Pinned and reviewed Python/uvx package.",
      "URL and private-network egress policy.",
    ],
    rationale:
      "Useful for reading selected pages, but it is not needed for the core runtime and is broader than search.",
    risks: [
      "The upstream documentation warns that it can access local or internal IP addresses.",
      "Fetched pages can contain prompt injection.",
    ],
  },
  {
    id: "mcp-filesystem-reference",
    name: "MCP reference Filesystem server",
    kind: "optional_mcp",
    disposition: "use_host_native_first",
    capabilities: ["workspace.read", "workspace.write"],
    license: "MIT",
    source:
      "https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem",
    network: false,
    credentials: false,
    defaultEnabled: false,
    prerequisites: [
      "An MCP-capable AgentHost.",
      "Explicit allowed directories.",
    ],
    rationale:
      "CharterMesh already provides narrower path-contained filesystem tools with exact write approval.",
    risks: [
      "A second filesystem executor can bypass or confuse the Control Plane approval path.",
    ],
  },
  {
    id: "mcp-git-reference",
    name: "MCP reference Git server",
    kind: "optional_mcp",
    disposition: "use_host_native_first",
    capabilities: ["repository.git"],
    license: "MIT",
    source:
      "https://github.com/modelcontextprotocol/servers/tree/main/src/git",
    network: false,
    credentials: false,
    defaultEnabled: false,
    prerequisites: [
      "An MCP-capable AgentHost.",
      "One explicitly scoped repository.",
      "A mutation approval policy.",
    ],
    rationale:
      "Useful for hosts without native Git support; unnecessary for most coding agents and not a Control Plane ledger.",
    risks: [
      "Mutation tools can alter branches, index state, or user changes.",
    ],
  },
  {
    id: "playwright-mcp",
    name: "Microsoft Playwright MCP",
    kind: "optional_mcp",
    disposition: "opt_in",
    capabilities: ["browser.automation", "ui.accessibility_snapshot"],
    license: "Apache-2.0",
    source: "https://github.com/microsoft/playwright-mcp",
    network: true,
    credentials: false,
    defaultEnabled: false,
    prerequisites: [
      "An MCP-capable AgentHost.",
      "Pinned and reviewed package/browser binaries.",
      "A dedicated browser profile and scoped origins.",
    ],
    rationale:
      "Adds reproducible browser QA when the host has no suitable native browser capability.",
    risks: [
      "Browser sessions can expose cookies, local services, and authenticated pages.",
      "Package and browser downloads are external installations.",
    ],
  },
];

export function recommendedCapabilities(): readonly CapabilityCatalogEntry[] {
  return capabilityCatalog.filter(({ disposition }) =>
    ["built_in", "opt_in"].includes(disposition),
  );
}
