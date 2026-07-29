import { readFileSync } from "node:fs";

type Schema = boolean | Record<string, unknown>;

export interface JsonSchemaIssue {
  keyword: string;
  path: string;
  message: string;
}

let cachedSchema: Record<string, unknown> | undefined;

function schemaDocument(): Record<string, unknown> {
  cachedSchema ??= JSON.parse(
    readFileSync(
      new URL("../../../schemas/orgspec-v1alpha1.schema.json", import.meta.url),
      "utf8",
    ),
  ) as Record<string, unknown>;
  return cachedSchema;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function childPath(path: string, key: string | number): string {
  const escaped = String(key).replaceAll("~", "~0").replaceAll("/", "~1");
  return path === "/" ? `/${escaped}` : `${path}/${escaped}`;
}

function resolveReference(
  root: Record<string, unknown>,
  reference: string,
): Schema {
  if (!reference.startsWith("#/")) {
    throw new Error(`Only local JSON Schema references are supported: ${reference}`);
  }
  let value: unknown = root;
  for (const segment of reference
    .slice(2)
    .split("/")
    .map((item) => item.replaceAll("~1", "/").replaceAll("~0", "~"))) {
    if (!isRecord(value) || !(segment in value)) {
      throw new Error(`Unknown JSON Schema reference: ${reference}`);
    }
    value = value[segment];
  }
  if (typeof value !== "boolean" && !isRecord(value)) {
    throw new Error(`Invalid JSON Schema reference: ${reference}`);
  }
  return value;
}

function matchesType(value: unknown, expected: string): boolean {
  if (expected === "array") return Array.isArray(value);
  if (expected === "object") return isRecord(value);
  if (expected === "integer") return Number.isInteger(value);
  if (expected === "number") {
    return typeof value === "number" && Number.isFinite(value);
  }
  if (expected === "null") return value === null;
  return typeof value === expected;
}

function validateNode(
  root: Record<string, unknown>,
  schema: Schema,
  value: unknown,
  path: string,
): JsonSchemaIssue[] {
  if (schema === true) return [];
  if (schema === false) {
    return [{ keyword: "falseSchema", path, message: "Value is not allowed." }];
  }
  if (typeof schema.$ref === "string") {
    return validateNode(root, resolveReference(root, schema.$ref), value, path);
  }

  const issues: JsonSchemaIssue[] = [];
  if (Array.isArray(schema.allOf)) {
    for (const nested of schema.allOf) {
      if (typeof nested === "boolean" || isRecord(nested)) {
        issues.push(...validateNode(root, nested, value, path));
      }
    }
  }
  if (Array.isArray(schema.anyOf)) {
    const matches = schema.anyOf.filter(
      (nested) =>
        (typeof nested === "boolean" || isRecord(nested)) &&
        validateNode(root, nested, value, path).length === 0,
    );
    if (matches.length === 0) {
      issues.push({
        keyword: "anyOf",
        path,
        message: "Value does not match any allowed schema.",
      });
    }
  }
  if (Array.isArray(schema.oneOf)) {
    const matches = schema.oneOf.filter(
      (nested) =>
        (typeof nested === "boolean" || isRecord(nested)) &&
        validateNode(root, nested, value, path).length === 0,
    );
    if (matches.length !== 1) {
      issues.push({
        keyword: "oneOf",
        path,
        message: "Value must match exactly one allowed schema.",
      });
    }
  }
  if (typeof schema.if === "boolean" || isRecord(schema.if)) {
    const conditionMatches =
      validateNode(root, schema.if, value, path).length === 0;
    const selected = conditionMatches ? schema.then : schema.else;
    if (typeof selected === "boolean" || isRecord(selected)) {
      issues.push(...validateNode(root, selected, value, path));
    }
  }

  const expectedTypes =
    typeof schema.type === "string"
      ? [schema.type]
      : Array.isArray(schema.type)
        ? schema.type.filter((item): item is string => typeof item === "string")
        : [];
  if (
    expectedTypes.length > 0 &&
    !expectedTypes.some((expected) => matchesType(value, expected))
  ) {
    issues.push({
      keyword: "type",
      path,
      message: `Expected ${expectedTypes.join(" or ")}.`,
    });
    return issues;
  }
  if ("const" in schema && !same(value, schema.const)) {
    issues.push({
      keyword: "const",
      path,
      message: "Value does not match the required constant.",
    });
  }
  if (
    Array.isArray(schema.enum) &&
    !schema.enum.some((candidate) => same(value, candidate))
  ) {
    issues.push({
      keyword: "enum",
      path,
      message: "Value is not in the allowed set.",
    });
  }

  if (typeof value === "string") {
    if (
      typeof schema.minLength === "number" &&
      value.length < schema.minLength
    ) {
      issues.push({
        keyword: "minLength",
        path,
        message: `String must contain at least ${schema.minLength} characters.`,
      });
    }
    if (
      typeof schema.pattern === "string" &&
      !new RegExp(schema.pattern, "u").test(value)
    ) {
      issues.push({
        keyword: "pattern",
        path,
        message: "String does not match the required pattern.",
      });
    }
  }

  if (
    typeof value === "number" &&
    typeof schema.minimum === "number" &&
    value < schema.minimum
  ) {
    issues.push({
      keyword: "minimum",
      path,
      message: `Number must be at least ${schema.minimum}.`,
    });
  }

  if (Array.isArray(value)) {
    if (
      typeof schema.minItems === "number" &&
      value.length < schema.minItems
    ) {
      issues.push({
        keyword: "minItems",
        path,
        message: `Array must contain at least ${schema.minItems} items.`,
      });
    }
    if (schema.uniqueItems === true) {
      const canonical = value.map((item) => JSON.stringify(item));
      if (new Set(canonical).size !== canonical.length) {
        issues.push({
          keyword: "uniqueItems",
          path,
          message: "Array items must be unique.",
        });
      }
    }
    if (typeof schema.items === "boolean" || isRecord(schema.items)) {
      value.forEach((item, index) => {
        issues.push(
          ...validateNode(root, schema.items as Schema, item, childPath(path, index)),
        );
      });
    }
  }

  if (isRecord(value)) {
    const required = Array.isArray(schema.required)
      ? schema.required.filter(
          (item): item is string => typeof item === "string",
        )
      : [];
    for (const key of required) {
      if (!(key in value)) {
        issues.push({
          keyword: "required",
          path: childPath(path, key),
          message: `Required property '${key}' is missing.`,
        });
      }
    }
    const properties = isRecord(schema.properties)
      ? schema.properties
      : {};
    for (const [key, nestedValue] of Object.entries(value)) {
      const nested = properties[key];
      if (typeof nested === "boolean" || isRecord(nested)) {
        issues.push(
          ...validateNode(root, nested, nestedValue, childPath(path, key)),
        );
      } else if (schema.additionalProperties === false) {
        issues.push({
          keyword: "additionalProperties",
          path: childPath(path, key),
          message: `Unknown property '${key}' is not allowed.`,
        });
      }
    }
  }

  return issues;
}

export function validateOrgSpecSchema(value: unknown): JsonSchemaIssue[] {
  const root = schemaDocument();
  return validateJsonSchemaDocument(root, value);
}

export function validateJsonSchemaDocument(
  schema: Record<string, unknown>,
  value: unknown,
): JsonSchemaIssue[] {
  return validateNode(schema, schema, value, "/");
}
