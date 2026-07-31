import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";

export const ARTIFACT_CANDIDATE_API_VERSION =
  "chartermesh.dev/artifact-candidate/v1alpha1" as const;
export const MAX_ARTIFACT_CANDIDATE_BYTES = 256 * 1024;

export type ArtifactFamily =
  | "product_package"
  | "research"
  | "xlsx"
  | "docx"
  | "pptx";
export type ArtifactDifficulty = "easy" | "medium" | "hard";
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface ProductPackageIr {
  kind: "product_package";
  name: string;
  positioning: {
    audience: string;
    problem: string;
    promise: string;
  };
  deliverables: Array<{
    id: string;
    name: string;
    acceptance: string[];
  }>;
  launchChecklist: Array<{
    id: string;
    owner: string;
    done: boolean;
  }>;
}

export interface ResearchIr {
  kind: "research";
  question: string;
  sources: Array<{
    id: string;
    title: string;
    url: string;
    publishedDate: string;
  }>;
  findings: Array<{
    id: string;
    claim: string;
    sourceIds: string[];
    confidence: "low" | "medium" | "high";
  }>;
  limitations: string[];
}

/**
 * A workbook semantic IR. It intentionally is not an OOXML file and does not
 * prove layout, formula execution, interoperability, or visual quality. A
 * later renderer/export verifier must cover those concerns.
 */
export interface XlsxIr {
  kind: "xlsx";
  workbookTitle: string;
  sheets: Array<{
    name: string;
    columns: Array<{
      key: string;
      header: string;
      type: "text" | "number" | "date" | "boolean" | "currency";
    }>;
    rows: Array<{
      cells: Array<{
        columnKey: string;
        value: JsonPrimitive;
      }>;
    }>;
    formulas: Array<{
      cell: string;
      expression: string;
      dependsOn: string[];
    }>;
  }>;
  namedRanges: string[];
}

export type DocxBlock =
  | { type: "paragraph"; text: string }
  | { type: "bullets"; items: string[] }
  | { type: "table"; headers: string[]; rows: string[][] };

/**
 * A word-processing semantic IR. It is a content gate, not a DOCX package,
 * pagination check, accessibility audit, or render-quality assertion.
 */
export interface DocxIr {
  kind: "docx";
  title: string;
  audience: string;
  sections: Array<{
    id: string;
    heading: string;
    blocks: DocxBlock[];
  }>;
  reviewChecklist: string[];
}

export type PptxBody =
  | { type: "bullets"; items: string[] }
  | { type: "metric"; label: string; value: string; context: string }
  | {
      type: "timeline";
      milestones: Array<{ label: string; date: string }>;
    };

/**
 * A presentation semantic IR. It is not PPTX/OOXML and cannot establish
 * slide rendering, theme fidelity, animation behavior, or visual polish.
 */
export interface PptxIr {
  kind: "pptx";
  title: string;
  theme: string;
  slides: Array<{
    id: string;
    title: string;
    purpose: string;
    body: PptxBody;
    speakerNotes: string;
  }>;
  narrative: string[];
}

export type ArtifactIr =
  | ProductPackageIr
  | ResearchIr
  | XlsxIr
  | DocxIr
  | PptxIr;

export interface ArtifactCandidateEnvelope {
  apiVersion: typeof ARTIFACT_CANDIDATE_API_VERSION;
  taskId: string;
  artifact: ArtifactIr;
}

export const ARTIFACT_ORACLE_OPERATORS = [
  "exists",
  "equals",
  "contains",
  "min_items",
  "max_items",
  "unique_by",
  "number_at_least",
  "string_includes",
] as const;

export type ArtifactOracleOperator =
  (typeof ARTIFACT_ORACLE_OPERATORS)[number];

export type ArtifactOracleRequirement =
  | { id: string; path: string; operator: "exists" }
  | {
      id: string;
      path: string;
      operator: "equals" | "contains";
      expected: JsonValue;
    }
  | {
      id: string;
      path: string;
      operator: "min_items" | "max_items" | "number_at_least";
      expected: number;
    }
  | { id: string; path: string; operator: "unique_by"; key: string }
  | {
      id: string;
      path: string;
      operator: "string_includes";
      expected: string;
    };

export interface ArtifactOracleCheck {
  requirementId: string;
  operator: ArtifactOracleOperator;
  passed: boolean;
  reason:
    | "PASS"
    | "PATH_MISSING"
    | "TYPE_MISMATCH"
    | "VALUE_MISMATCH"
    | "DUPLICATE_VALUE";
}

export interface ArtifactOracleResult {
  passed: boolean;
  passedRequirementIds: string[];
  failedRequirementIds: string[];
  checks: ArtifactOracleCheck[];
}

export class ArtifactValidationError extends Error {
  readonly code = "ARTIFACT_SCHEMA_INVALID";
}

export class ArtifactCandidateParseError extends Error {
  readonly code:
    | "CANDIDATE_EMPTY"
    | "CANDIDATE_TOO_LARGE"
    | "CANDIDATE_NOT_JSON"
    | "CANDIDATE_DUPLICATE_KEY"
    | "CANDIDATE_SCHEMA_INVALID";

  constructor(
    code:
      | "CANDIDATE_EMPTY"
      | "CANDIDATE_TOO_LARGE"
      | "CANDIDATE_NOT_JSON"
      | "CANDIDATE_DUPLICATE_KEY"
      | "CANDIDATE_SCHEMA_INVALID",
    message: string,
  ) {
    super(message);
    this.code = code;
  }
}

const IDENTIFIER = /^[a-z][a-z0-9-]{0,63}$/u;
const COLUMN_KEY = /^[a-z][a-z0-9_]{0,63}$/u;
const CELL_REFERENCE = /^[A-Z]{1,3}[1-9][0-9]{0,5}$/u;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u;
const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const MAX_COLLECTION_ITEMS = 512;
const MAX_JSON_DEPTH = 64;

function fail(message: string): never {
  throw new ArtifactValidationError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    fail(`${label} must contain exactly: ${wanted.join(", ")}.`);
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) fail(`${label} must be an object.`);
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEYS.has(key)) fail(`${label} contains a forbidden key.`);
  }
  return value;
}

function text(
  value: unknown,
  label: string,
  options: { max?: number; pattern?: RegExp; allowEmpty?: boolean } = {},
): string {
  const max = options.max ?? 4096;
  if (
    typeof value !== "string" ||
    value.length > max ||
    (!options.allowEmpty && value.trim().length === 0) ||
    value.includes("\0") ||
    (options.pattern !== undefined && !options.pattern.test(value))
  ) {
    fail(`${label} is not a valid bounded string.`);
  }
  return value;
}

function identifier(value: unknown, label: string): string {
  return text(value, label, { max: 64, pattern: IDENTIFIER });
}

function list(
  value: unknown,
  label: string,
  options: { min?: number; max?: number } = {},
): unknown[] {
  const min = options.min ?? 0;
  const max = options.max ?? MAX_COLLECTION_ITEMS;
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    fail(`${label} must contain ${min}..${max} items.`);
  }
  return value;
}

function stringList(
  value: unknown,
  label: string,
  options: { min?: number; max?: number } = {},
): string[] {
  return list(value, label, options).map((item, index) =>
    text(item, `${label}[${index}]`),
  );
}

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) {
    fail(`${label} must be unique.`);
  }
}

function validateProductPackage(value: Record<string, unknown>): void {
  assertExactKeys(
    value,
    ["kind", "name", "positioning", "deliverables", "launchChecklist"],
    "product package",
  );
  text(value.name, "product package name", { max: 160 });
  const positioning = record(value.positioning, "positioning");
  assertExactKeys(
    positioning,
    ["audience", "problem", "promise"],
    "positioning",
  );
  text(positioning.audience, "positioning audience", { max: 1000 });
  text(positioning.problem, "positioning problem", { max: 2000 });
  text(positioning.promise, "positioning promise", { max: 2000 });
  const deliverables = list(value.deliverables, "deliverables", {
    min: 1,
    max: 64,
  });
  const deliverableIds = deliverables.map((item, index) => {
    const child = record(item, `deliverables[${index}]`);
    assertExactKeys(child, ["id", "name", "acceptance"], "deliverable");
    const id = identifier(child.id, `deliverables[${index}].id`);
    text(child.name, `deliverables[${index}].name`, { max: 240 });
    stringList(child.acceptance, `deliverables[${index}].acceptance`, {
      min: 1,
      max: 32,
    });
    return id;
  });
  assertUnique(deliverableIds, "deliverable ids");
  const checklist = list(value.launchChecklist, "launch checklist", {
    min: 1,
    max: 64,
  });
  const checklistIds = checklist.map((item, index) => {
    const child = record(item, `launchChecklist[${index}]`);
    assertExactKeys(child, ["id", "owner", "done"], "checklist item");
    const id = identifier(child.id, `launchChecklist[${index}].id`);
    text(child.owner, `launchChecklist[${index}].owner`, { max: 160 });
    if (typeof child.done !== "boolean") fail("checklist done must be boolean.");
    return id;
  });
  assertUnique(checklistIds, "checklist ids");
}

function validateResearch(value: Record<string, unknown>): void {
  assertExactKeys(
    value,
    ["kind", "question", "sources", "findings", "limitations"],
    "research",
  );
  text(value.question, "research question", { max: 2000 });
  const sources = list(value.sources, "sources", { min: 1, max: 128 });
  const sourceIds = sources.map((item, index) => {
    const child = record(item, `sources[${index}]`);
    assertExactKeys(
      child,
      ["id", "title", "url", "publishedDate"],
      "source",
    );
    const id = identifier(child.id, `sources[${index}].id`);
    text(child.title, `sources[${index}].title`, { max: 500 });
    const url = text(child.url, `sources[${index}].url`, { max: 2048 });
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      fail(`sources[${index}].url must be an absolute URL.`);
    }
    if (
      parsed.protocol !== "https:" ||
      parsed.username.length > 0 ||
      parsed.password.length > 0
    ) {
      fail(`sources[${index}].url must be credential-free HTTPS.`);
    }
    text(child.publishedDate, `sources[${index}].publishedDate`, {
      max: 10,
      pattern: ISO_DATE,
    });
    return id;
  });
  assertUnique(sourceIds, "source ids");
  const knownSources = new Set(sourceIds);
  const findings = list(value.findings, "findings", { min: 1, max: 128 });
  const findingIds = findings.map((item, index) => {
    const child = record(item, `findings[${index}]`);
    assertExactKeys(
      child,
      ["id", "claim", "sourceIds", "confidence"],
      "finding",
    );
    const id = identifier(child.id, `findings[${index}].id`);
    text(child.claim, `findings[${index}].claim`, { max: 4000 });
    const cited = stringList(child.sourceIds, `findings[${index}].sourceIds`, {
      min: 1,
      max: 32,
    });
    assertUnique(cited, `findings[${index}] source ids`);
    if (cited.some((sourceId) => !knownSources.has(sourceId))) {
      fail(`findings[${index}] cites an unknown source.`);
    }
    if (!(["low", "medium", "high"] as const).includes(child.confidence as never)) {
      fail(`findings[${index}].confidence is invalid.`);
    }
    return id;
  });
  assertUnique(findingIds, "finding ids");
  stringList(value.limitations, "limitations", { max: 64 });
}

function validateXlsx(value: Record<string, unknown>): void {
  assertExactKeys(value, ["kind", "workbookTitle", "sheets", "namedRanges"], "xlsx");
  text(value.workbookTitle, "workbook title", { max: 240 });
  const sheets = list(value.sheets, "sheets", { min: 1, max: 64 });
  const sheetNames = sheets.map((item, sheetIndex) => {
    const sheet = record(item, `sheets[${sheetIndex}]`);
    assertExactKeys(sheet, ["name", "columns", "rows", "formulas"], "sheet");
    const name = text(sheet.name, `sheets[${sheetIndex}].name`, { max: 31 });
    const columns = list(sheet.columns, `sheets[${sheetIndex}].columns`, {
      min: 1,
      max: 128,
    });
    const keys = columns.map((columnValue, columnIndex) => {
      const column = record(
        columnValue,
        `sheets[${sheetIndex}].columns[${columnIndex}]`,
      );
      assertExactKeys(column, ["key", "header", "type"], "column");
      const key = text(column.key, "column key", {
        max: 64,
        pattern: COLUMN_KEY,
      });
      text(column.header, "column header", { max: 240 });
      if (
        !(["text", "number", "date", "boolean", "currency"] as const).includes(
          column.type as never,
        )
      ) {
        fail("column type is invalid.");
      }
      return key;
    });
    assertUnique(keys, `sheets[${sheetIndex}] column keys`);
    const keySet = new Set(keys);
    for (const [rowIndex, rowValue] of list(
      sheet.rows,
      `sheets[${sheetIndex}].rows`,
      { max: 512 },
    ).entries()) {
      const row = record(rowValue, `sheets[${sheetIndex}].rows[${rowIndex}]`);
      assertExactKeys(row, ["cells"], "workbook row");
      const seenCellKeys = new Set<string>();
      for (const [cellIndex, cellValue] of list(
        row.cells,
        `sheets[${sheetIndex}].rows[${rowIndex}].cells`,
        { max: 128 },
      ).entries()) {
        const cellRecord = record(
          cellValue,
          `sheets[${sheetIndex}].rows[${rowIndex}].cells[${cellIndex}]`,
        );
        assertExactKeys(cellRecord, ["columnKey", "value"], "workbook cell");
        const key = text(cellRecord.columnKey, "cell column key", {
          max: 64,
          pattern: COLUMN_KEY,
        });
        if (!keySet.has(key)) fail(`row contains unknown column '${key}'.`);
        if (seenCellKeys.has(key)) fail(`row repeats column '${key}'.`);
        seenCellKeys.add(key);
        const cell = cellRecord.value;
        if (
          cell !== null &&
          typeof cell !== "string" &&
          typeof cell !== "number" &&
          typeof cell !== "boolean"
        ) {
          fail("workbook cell must be a JSON primitive.");
        }
        if (typeof cell === "number" && !Number.isFinite(cell)) {
          fail("workbook number must be finite.");
        }
        if (typeof cell === "string") text(cell, "workbook string cell", { max: 4000, allowEmpty: true });
      }
    }
    for (const [formulaIndex, formulaValue] of list(
      sheet.formulas,
      `sheets[${sheetIndex}].formulas`,
      { max: 128 },
    ).entries()) {
      const formula = record(
        formulaValue,
        `sheets[${sheetIndex}].formulas[${formulaIndex}]`,
      );
      assertExactKeys(formula, ["cell", "expression", "dependsOn"], "formula");
      text(formula.cell, "formula cell", { max: 12, pattern: CELL_REFERENCE });
      text(formula.expression, "formula expression", { max: 1000 });
      stringList(formula.dependsOn, "formula dependencies", { max: 128 });
    }
    return name;
  });
  assertUnique(sheetNames, "sheet names");
  const ranges = stringList(value.namedRanges, "named ranges", { max: 128 });
  assertUnique(ranges, "named ranges");
}

function validateDocxBlock(value: unknown, label: string): void {
  const block = record(value, label);
  if (block.type === "paragraph") {
    assertExactKeys(block, ["type", "text"], label);
    text(block.text, `${label}.text`, { max: 12000 });
    return;
  }
  if (block.type === "bullets") {
    assertExactKeys(block, ["type", "items"], label);
    stringList(block.items, `${label}.items`, { min: 1, max: 128 });
    return;
  }
  if (block.type === "table") {
    assertExactKeys(block, ["type", "headers", "rows"], label);
    const headers = stringList(block.headers, `${label}.headers`, { min: 1, max: 32 });
    for (const [index, rowValue] of list(block.rows, `${label}.rows`, { min: 1, max: 128 }).entries()) {
      const row = stringList(rowValue, `${label}.rows[${index}]`, { max: 32 });
      if (row.length !== headers.length) fail(`${label}.rows[${index}] width must match headers.`);
    }
    return;
  }
  fail(`${label}.type is invalid.`);
}

function validateDocx(value: Record<string, unknown>): void {
  assertExactKeys(value, ["kind", "title", "audience", "sections", "reviewChecklist"], "docx");
  text(value.title, "document title", { max: 240 });
  text(value.audience, "document audience", { max: 1000 });
  const sections = list(value.sections, "sections", { min: 1, max: 128 });
  const sectionIds = sections.map((item, index) => {
    const section = record(item, `sections[${index}]`);
    assertExactKeys(section, ["id", "heading", "blocks"], "section");
    const id = identifier(section.id, `sections[${index}].id`);
    text(section.heading, `sections[${index}].heading`, { max: 500 });
    list(section.blocks, `sections[${index}].blocks`, { min: 1, max: 128 }).forEach(
      (block, blockIndex) => validateDocxBlock(block, `sections[${index}].blocks[${blockIndex}]`),
    );
    return id;
  });
  assertUnique(sectionIds, "section ids");
  stringList(value.reviewChecklist, "review checklist", { max: 128 });
}

function validatePptxBody(value: unknown, label: string): void {
  const body = record(value, label);
  if (body.type === "bullets") {
    assertExactKeys(body, ["type", "items"], label);
    stringList(body.items, `${label}.items`, { min: 1, max: 32 });
    return;
  }
  if (body.type === "metric") {
    assertExactKeys(body, ["type", "label", "value", "context"], label);
    text(body.label, `${label}.label`, { max: 240 });
    text(body.value, `${label}.value`, { max: 120 });
    text(body.context, `${label}.context`, { max: 1000 });
    return;
  }
  if (body.type === "timeline") {
    assertExactKeys(body, ["type", "milestones"], label);
    for (const [index, item] of list(body.milestones, `${label}.milestones`, { min: 1, max: 32 }).entries()) {
      const milestone = record(item, `${label}.milestones[${index}]`);
      assertExactKeys(milestone, ["label", "date"], "milestone");
      text(milestone.label, "milestone label", { max: 240 });
      text(milestone.date, "milestone date", { max: 40 });
    }
    return;
  }
  fail(`${label}.type is invalid.`);
}

function validatePptx(value: Record<string, unknown>): void {
  assertExactKeys(value, ["kind", "title", "theme", "slides", "narrative"], "pptx");
  text(value.title, "presentation title", { max: 240 });
  text(value.theme, "presentation theme", { max: 240 });
  const slides = list(value.slides, "slides", { min: 1, max: 128 });
  const slideIds = slides.map((item, index) => {
    const slide = record(item, `slides[${index}]`);
    assertExactKeys(slide, ["id", "title", "purpose", "body", "speakerNotes"], "slide");
    const id = identifier(slide.id, `slides[${index}].id`);
    text(slide.title, `slides[${index}].title`, { max: 240 });
    text(slide.purpose, `slides[${index}].purpose`, { max: 1000 });
    validatePptxBody(slide.body, `slides[${index}].body`);
    text(slide.speakerNotes, `slides[${index}].speakerNotes`, { max: 8000 });
    return id;
  });
  assertUnique(slideIds, "slide ids");
  stringList(value.narrative, "presentation narrative", { max: 128 });
}

export function validateArtifactIr(value: unknown): ArtifactIr {
  const artifact = record(value, "artifact");
  if (artifact.kind === "product_package") validateProductPackage(artifact);
  else if (artifact.kind === "research") validateResearch(artifact);
  else if (artifact.kind === "xlsx") validateXlsx(artifact);
  else if (artifact.kind === "docx") validateDocx(artifact);
  else if (artifact.kind === "pptx") validatePptx(artifact);
  else fail("artifact.kind is not supported.");
  return artifact as unknown as ArtifactIr;
}

export function validateArtifactCandidateEnvelope(
  value: unknown,
  expected: { taskId?: string; family?: ArtifactFamily } = {},
): ArtifactCandidateEnvelope {
  const envelope = record(value, "candidate envelope");
  assertExactKeys(envelope, ["apiVersion", "taskId", "artifact"], "candidate envelope");
  if (envelope.apiVersion !== ARTIFACT_CANDIDATE_API_VERSION) {
    fail("candidate apiVersion is unsupported.");
  }
  const taskId = identifier(envelope.taskId, "candidate taskId");
  if (expected.taskId !== undefined && taskId !== expected.taskId) {
    fail("candidate taskId does not match the requested task.");
  }
  const artifact = validateArtifactIr(envelope.artifact);
  if (expected.family !== undefined && artifact.kind !== expected.family) {
    fail("candidate artifact family does not match the requested task.");
  }
  return { apiVersion: ARTIFACT_CANDIDATE_API_VERSION, taskId, artifact };
}

function parseStrictJson(source: string): unknown {
  let cursor = 0;
  let collectionItems = 0;
  const whitespace = /[ \t\r\n]/u;

  function skipWhitespace(): void {
    while (cursor < source.length && whitespace.test(source[cursor]!)) cursor += 1;
  }

  function parseString(): string {
    const start = cursor;
    cursor += 1;
    let escaped = false;
    while (cursor < source.length) {
      const character = source[cursor]!;
      cursor += 1;
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        try {
          return JSON.parse(source.slice(start, cursor)) as string;
        } catch {
          throw new Error("invalid JSON string");
        }
      }
    }
    throw new Error("unterminated JSON string");
  }

  function parseValue(depth: number): unknown {
    if (depth > MAX_JSON_DEPTH) throw new Error("JSON nesting limit exceeded");
    skipWhitespace();
    const character = source[cursor];
    if (character === '"') return parseString();
    if (character === "{") {
      cursor += 1;
      const object: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      const keys = new Set<string>();
      skipWhitespace();
      if (source[cursor] === "}") {
        cursor += 1;
        return object;
      }
      while (cursor < source.length) {
        skipWhitespace();
        if (source[cursor] !== '"') throw new Error("object key must be a string");
        const key = parseString();
        if (keys.has(key)) {
          throw new ArtifactCandidateParseError(
            "CANDIDATE_DUPLICATE_KEY",
            `Candidate contains duplicate object key '${key}'.`,
          );
        }
        if (FORBIDDEN_KEYS.has(key)) throw new Error("forbidden object key");
        keys.add(key);
        skipWhitespace();
        if (source[cursor] !== ":") throw new Error("missing object colon");
        cursor += 1;
        object[key] = parseValue(depth + 1);
        collectionItems += 1;
        if (collectionItems > MAX_COLLECTION_ITEMS * 16) throw new Error("JSON collection limit exceeded");
        skipWhitespace();
        if (source[cursor] === "}") {
          cursor += 1;
          return object;
        }
        if (source[cursor] !== ",") throw new Error("missing object comma");
        cursor += 1;
      }
      throw new Error("unterminated JSON object");
    }
    if (character === "[") {
      cursor += 1;
      const array: unknown[] = [];
      skipWhitespace();
      if (source[cursor] === "]") {
        cursor += 1;
        return array;
      }
      while (cursor < source.length) {
        array.push(parseValue(depth + 1));
        collectionItems += 1;
        if (collectionItems > MAX_COLLECTION_ITEMS * 16) throw new Error("JSON collection limit exceeded");
        skipWhitespace();
        if (source[cursor] === "]") {
          cursor += 1;
          return array;
        }
        if (source[cursor] !== ",") throw new Error("missing array comma");
        cursor += 1;
      }
      throw new Error("unterminated JSON array");
    }
    for (const [literal, value] of [
      ["true", true],
      ["false", false],
      ["null", null],
    ] as const) {
      if (source.startsWith(literal, cursor)) {
        cursor += literal.length;
        return value;
      }
    }
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u.exec(source.slice(cursor));
    if (match !== null) {
      cursor += match[0].length;
      const value = Number(match[0]);
      if (!Number.isFinite(value)) throw new Error("JSON number must be finite");
      return value;
    }
    throw new Error("invalid JSON value");
  }

  const value = parseValue(0);
  skipWhitespace();
  if (cursor !== source.length) throw new Error("trailing content after JSON value");
  return value;
}

export function parseArtifactCandidate(
  source: string,
  expected: { taskId?: string; family?: ArtifactFamily } = {},
): ArtifactCandidateEnvelope {
  if (typeof source !== "string" || source.trim().length === 0) {
    throw new ArtifactCandidateParseError("CANDIDATE_EMPTY", "Candidate is empty.");
  }
  const bytes = Buffer.byteLength(source, "utf8");
  if (bytes > MAX_ARTIFACT_CANDIDATE_BYTES) {
    throw new ArtifactCandidateParseError(
      "CANDIDATE_TOO_LARGE",
      `Candidate is ${bytes} bytes; limit is ${MAX_ARTIFACT_CANDIDATE_BYTES}.`,
    );
  }
  if (source.charCodeAt(0) === 0xfeff) {
    throw new ArtifactCandidateParseError("CANDIDATE_NOT_JSON", "Candidate must not contain a BOM.");
  }
  let value: unknown;
  try {
    value = parseStrictJson(source);
  } catch (error) {
    if (error instanceof ArtifactCandidateParseError) throw error;
    throw new ArtifactCandidateParseError(
      "CANDIDATE_NOT_JSON",
      `Candidate is not one strict JSON value: ${error instanceof Error ? error.message : "invalid input"}.`,
    );
  }
  try {
    return validateArtifactCandidateEnvelope(value, expected);
  } catch (error) {
    throw new ArtifactCandidateParseError(
      "CANDIDATE_SCHEMA_INVALID",
      error instanceof Error ? error.message : "Candidate schema is invalid.",
    );
  }
}

function canonicalize(value: unknown, stack: Set<object>): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Canonical JSON rejects non-finite numbers.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (stack.has(value)) throw new TypeError("Canonical JSON rejects cycles.");
    stack.add(value);
    const result = `[${value.map((item) => canonicalize(item, stack)).join(",")}]`;
    stack.delete(value);
    return result;
  }
  if (isRecord(value)) {
    if (stack.has(value)) throw new TypeError("Canonical JSON rejects cycles.");
    stack.add(value);
    const entries = Object.keys(value)
      .sort()
      .map((key) => {
        if (FORBIDDEN_KEYS.has(key)) throw new TypeError("Canonical JSON rejects unsafe keys.");
        const child = value[key];
        if (child === undefined || typeof child === "function" || typeof child === "symbol" || typeof child === "bigint") {
          throw new TypeError("Canonical JSON rejects non-JSON values.");
        }
        return `${JSON.stringify(key)}:${canonicalize(child, stack)}`;
      });
    stack.delete(value);
    return `{${entries.join(",")}}`;
  }
  throw new TypeError("Canonical JSON accepts JSON values only.");
}

export function canonicalArtifactJson(value: unknown): string {
  return canonicalize(value, new Set<object>());
}

export function canonicalArtifactSha256(value: unknown): string {
  return createHash("sha256").update(canonicalArtifactJson(value)).digest("hex");
}

function validateJsonValue(value: unknown): asserts value is JsonValue {
  canonicalArtifactJson(value);
}

function validatePointer(path: unknown): string {
  if (typeof path !== "string" || path.length > 1024 || (path !== "" && !path.startsWith("/"))) {
    throw new TypeError("Oracle path must be a bounded JSON pointer.");
  }
  const segments = path === "" ? [] : path.slice(1).split("/");
  if (segments.length > 32) throw new TypeError("Oracle path is too deep.");
  for (const raw of segments) {
    if (/~(?:[^01]|$)/u.test(raw)) throw new TypeError("Oracle path has invalid escaping.");
    const segment = raw.replace(/~1/gu, "/").replace(/~0/gu, "~");
    if (segment.length > 128 || FORBIDDEN_KEYS.has(segment)) {
      throw new TypeError("Oracle path contains an unsafe segment.");
    }
  }
  return path;
}

function validateRequirement(value: ArtifactOracleRequirement): void {
  const requirement = record(value, "oracle requirement");
  identifier(requirement.id, "oracle requirement id");
  validatePointer(requirement.path);
  if (!(ARTIFACT_ORACLE_OPERATORS as readonly unknown[]).includes(requirement.operator)) {
    throw new TypeError("Oracle operator is not allowlisted.");
  }
  if (requirement.operator === "exists") {
    assertExactKeys(requirement, ["id", "path", "operator"], "exists requirement");
  } else if (requirement.operator === "unique_by") {
    assertExactKeys(requirement, ["id", "path", "operator", "key"], "unique_by requirement");
    identifier(requirement.key, "unique_by key");
  } else {
    assertExactKeys(requirement, ["id", "path", "operator", "expected"], "oracle requirement");
    if (
      requirement.operator === "min_items" ||
      requirement.operator === "max_items" ||
      requirement.operator === "number_at_least"
    ) {
      if (!Number.isSafeInteger(requirement.expected) || (requirement.expected as number) < 0) {
        throw new TypeError("Numeric oracle operand must be a non-negative safe integer.");
      }
    } else if (requirement.operator === "string_includes") {
      text(requirement.expected, "string_includes operand", { max: 2000 });
    } else {
      validateJsonValue(requirement.expected);
    }
  }
}

const MISSING = Symbol("missing");

function resolvePointer(root: unknown, path: string): unknown | typeof MISSING {
  let value = root;
  if (path === "") return value;
  for (const raw of path.slice(1).split("/")) {
    const segment = raw.replace(/~1/gu, "/").replace(/~0/gu, "~");
    if (Array.isArray(value)) {
      if (!/^(?:0|[1-9][0-9]*)$/u.test(segment)) return MISSING;
      const index = Number(segment);
      if (index >= value.length) return MISSING;
      value = value[index];
    } else if (isRecord(value) && Object.hasOwn(value, segment)) {
      value = value[segment];
    } else {
      return MISSING;
    }
  }
  return value;
}

function checkRequirement(
  artifact: ArtifactIr,
  requirement: ArtifactOracleRequirement,
): ArtifactOracleCheck {
  const actual = resolvePointer(artifact, requirement.path);
  let reason: ArtifactOracleCheck["reason"] = "VALUE_MISMATCH";
  if (actual === MISSING) reason = "PATH_MISSING";
  else if (requirement.operator === "exists") reason = "PASS";
  else if (requirement.operator === "equals") {
    reason = canonicalArtifactJson(actual) === canonicalArtifactJson(requirement.expected) ? "PASS" : "VALUE_MISMATCH";
  } else if (requirement.operator === "contains") {
    if (typeof actual === "string" && typeof requirement.expected === "string") {
      reason = actual.includes(requirement.expected) ? "PASS" : "VALUE_MISMATCH";
    } else if (Array.isArray(actual)) {
      const expected = canonicalArtifactJson(requirement.expected);
      reason = actual.some((item) => canonicalArtifactJson(item) === expected) ? "PASS" : "VALUE_MISMATCH";
    } else reason = "TYPE_MISMATCH";
  } else if (requirement.operator === "min_items" || requirement.operator === "max_items") {
    if (!Array.isArray(actual)) reason = "TYPE_MISMATCH";
    else if (requirement.operator === "min_items") reason = actual.length >= requirement.expected ? "PASS" : "VALUE_MISMATCH";
    else reason = actual.length <= requirement.expected ? "PASS" : "VALUE_MISMATCH";
  } else if (requirement.operator === "number_at_least") {
    reason = typeof actual !== "number" ? "TYPE_MISMATCH" : actual >= requirement.expected ? "PASS" : "VALUE_MISMATCH";
  } else if (requirement.operator === "string_includes") {
    reason = typeof actual !== "string" ? "TYPE_MISMATCH" : actual.includes(requirement.expected) ? "PASS" : "VALUE_MISMATCH";
  } else {
    if (!Array.isArray(actual)) reason = "TYPE_MISMATCH";
    else {
      const seen = new Set<string>();
      let duplicate = false;
      reason = "PASS";
      for (const item of actual) {
        if (!isRecord(item) || !Object.hasOwn(item, requirement.key)) {
          reason = "TYPE_MISMATCH";
          duplicate = false;
          break;
        }
        const key = canonicalArtifactJson(item[requirement.key]);
        if (seen.has(key)) {
          duplicate = true;
          break;
        }
        seen.add(key);
        reason = "PASS";
      }
      if (duplicate) reason = "DUPLICATE_VALUE";
    }
  }
  return {
    requirementId: requirement.id,
    operator: requirement.operator,
    passed: reason === "PASS",
    reason,
  };
}

/** Evaluates declarative, allowlisted predicates only; no candidate code runs. */
export function evaluateArtifactOracle(
  artifact: ArtifactIr,
  requirements: readonly ArtifactOracleRequirement[],
): ArtifactOracleResult {
  validateArtifactIr(artifact);
  if (requirements.length === 0 || requirements.length > 256) {
    throw new TypeError("Oracle must contain 1..256 requirements.");
  }
  const ids = new Set<string>();
  for (const requirement of requirements) {
    validateRequirement(requirement);
    if (ids.has(requirement.id)) throw new TypeError("Oracle requirement ids must be unique.");
    ids.add(requirement.id);
  }
  const checks = requirements.map((requirement) => checkRequirement(artifact, requirement));
  const passedRequirementIds = checks.filter(({ passed }) => passed).map(({ requirementId }) => requirementId);
  const failedRequirementIds = checks.filter(({ passed }) => !passed).map(({ requirementId }) => requirementId);
  return { passed: failedRequirementIds.length === 0, passedRequirementIds, failedRequirementIds, checks };
}
