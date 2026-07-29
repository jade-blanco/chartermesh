import type { OrganizationSpec } from "./types.ts";

export class OrgSpecParseError extends Error {
  readonly code = "ORGSPEC_PARSE_ERROR";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "OrgSpecParseError";
  }
}

export function parseOrgSpec(text: string): OrganizationSpec {
  try {
    return JSON.parse(text) as OrganizationSpec;
  } catch (cause) {
    throw new OrgSpecParseError(
      "The dependency-free bootstrap parser accepts JSON. YAML support is pending an approved parser dependency.",
      { cause },
    );
  }
}
