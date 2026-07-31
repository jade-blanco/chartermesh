import type { StructuredArtifact } from "./managed-runner.ts";

const MAX_SUMMARY_CHARS = 2_000;
const MAX_DELIVERABLE_CHARS = 20_000;
const MAX_LIST_ITEMS = 20;
const MAX_LIST_ITEM_CHARS = 1_000;

export interface ArtifactCompilerInput {
  text: string;
  summary?: string;
  checks?: string[];
  risks?: string[];
  nextActions?: string[];
  confidence?: StructuredArtifact["confidence"];
}

export interface ArtifactCompilerResult {
  artifact: StructuredArtifact;
  canonicalText: string;
  status: "complete" | "empty" | "truncated";
  diagnostics: string[];
}

function boundedText(
  value: string,
  maximum: number,
): { value: string; truncated: boolean } {
  const normalized = value.replace(/\u0000/gu, "").trim();
  if (normalized.length <= maximum) {
    return { value: normalized, truncated: false };
  }
  return {
    value: `${normalized.slice(0, maximum - 1).trimEnd()}…`,
    truncated: true,
  };
}

function boundedList(values: string[] | undefined): string[] {
  return (values ?? [])
    .map((value) => boundedText(value, MAX_LIST_ITEM_CHARS).value)
    .filter(Boolean)
    .slice(0, MAX_LIST_ITEMS);
}

function inferredSummary(text: string): string {
  const firstLine =
    text
      .split(/\r?\n/u)
      .map((line) =>
        line
          .replace(/^#{1,6}\s*/u, "")
          .replace(/^```[A-Za-z0-9_-]*\s*/u, "")
          .trim(),
      )
      .find(Boolean) ?? "Compiled model deliverable";
  return boundedText(firstLine, MAX_SUMMARY_CHARS).value;
}

export function compileStructuredArtifact(
  input: ArtifactCompilerInput,
): ArtifactCompilerResult {
  const diagnostics: string[] = [];
  const deliverable = boundedText(input.text, MAX_DELIVERABLE_CHARS);
  if (deliverable.truncated) diagnostics.push("DELIVERABLE_TRUNCATED");
  const empty = deliverable.value.length === 0;
  if (empty) diagnostics.push("MODEL_CONTENT_EMPTY");
  const summary = boundedText(
    input.summary?.trim() || inferredSummary(input.text),
    MAX_SUMMARY_CHARS,
  );
  if (summary.truncated) diagnostics.push("SUMMARY_TRUNCATED");
  const artifact: StructuredArtifact = {
    apiVersion: "chartermesh.dev/structured-artifact/v1alpha1",
    summary: summary.value || "Compiled model deliverable",
    deliverable:
      deliverable.value || "No model deliverable content was produced.",
    checks: boundedList(input.checks),
    risks: boundedList([
      ...(input.risks ?? []),
      ...(empty ? ["The model returned no deliverable content."] : []),
    ]),
    nextActions: boundedList(input.nextActions),
    confidence: empty ? "low" : (input.confidence ?? "medium"),
  };
  return {
    artifact,
    canonicalText: `${JSON.stringify(artifact, null, 2)}\n`,
    status: empty
      ? "empty"
      : deliverable.truncated
        ? "truncated"
        : "complete",
    diagnostics,
  };
}

export function extractFirstJsonObject(text: string): unknown | undefined {
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (start < 0) {
      if (character !== "{") continue;
      start = index;
      depth = 1;
      continue;
    }
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === "{") depth += 1;
    if (character === "}") {
      depth -= 1;
      if (depth !== 0) continue;
      try {
        return JSON.parse(text.slice(start, index + 1)) as unknown;
      } catch {
        start = -1;
        depth = 0;
      }
    }
  }
  return undefined;
}
