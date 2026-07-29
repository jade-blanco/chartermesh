import type { OrganizationSpec } from "./types.ts";
import { validateOrgSpecSchema } from "./json-schema.ts";

export class OrgSpecParseError extends Error {
  readonly code = "ORGSPEC_PARSE_ERROR";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "OrgSpecParseError";
  }
}

export function parseOrgSpec(text: string): OrganizationSpec {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (cause) {
    throw new OrgSpecParseError(
      "The dependency-free bootstrap parser accepts JSON. YAML support is pending an approved parser dependency.",
      { cause },
    );
  }

  const issues = validateOrgSpecSchema(value);
  if (issues.length > 0) {
    const details = issues
      .slice(0, 8)
      .map(({ path, keyword, message }) => `${path} [${keyword}] ${message}`)
      .join("; ");
    const remaining =
      issues.length > 8 ? `; and ${issues.length - 8} more issue(s)` : "";
    throw new OrgSpecParseError(
      `OrgSpec does not satisfy schemas/orgspec-v1alpha1.schema.json: ${details}${remaining}`,
    );
  }
  return value as OrganizationSpec;
}
