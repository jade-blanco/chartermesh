import { createHash } from "node:crypto";
import { extractFirstJsonObject } from "../../../../packages/runtime/src/index.ts";
import type { PublicCodeEvaluationTask } from "./suite.ts";

const CANDIDATE_API_VERSION =
  "chartermesh.dev/code-candidate/v1alpha1" as const;
const MAX_CANDIDATE_BYTES = 131_072;

export interface CodeCandidate {
  apiVersion: typeof CANDIDATE_API_VERSION;
  files: Array<{
    path: string;
    content: string;
  }>;
  summary: string;
}

export interface ParsedCodeCandidate {
  candidate?: CodeCandidate;
  rawOutputHash: string;
  candidateHash?: string;
  errorCode?:
    | "CANDIDATE_NOT_JSON"
    | "CANDIDATE_SCHEMA_INVALID"
    | "CANDIDATE_PATH_NOT_ALLOWED"
    | "CANDIDATE_SIZE_LIMIT";
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function exactKeys(
  value: Record<string, unknown>,
  expected: string[],
): boolean {
  const keys = Object.keys(value).sort();
  return (
    keys.length === expected.length &&
    keys.every((key, index) => key === [...expected].sort()[index])
  );
}

export function canonicalCandidateText(
  candidate: CodeCandidate,
): string {
  return `${JSON.stringify(candidate, null, 2)}\n`;
}

export function codeCandidateSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["apiVersion", "files", "summary"],
    properties: {
      apiVersion: { const: CANDIDATE_API_VERSION },
      files: {
        type: "array",
        minItems: 1,
        maxItems: 8,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["path", "content"],
          properties: {
            path: { type: "string", minLength: 1, maxLength: 200 },
            content: {
              type: "string",
              minLength: 1,
              maxLength: MAX_CANDIDATE_BYTES,
            },
          },
        },
      },
      summary: { type: "string", minLength: 1, maxLength: 2_000 },
    },
  };
}

export function parseCodeCandidate(
  rawOutput: string,
  allowedPaths: string[],
): ParsedCodeCandidate {
  const rawOutputHash = sha256(rawOutput);
  const value = extractFirstJsonObject(rawOutput);
  if (!value) return { rawOutputHash, errorCode: "CANDIDATE_NOT_JSON" };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { rawOutputHash, errorCode: "CANDIDATE_SCHEMA_INVALID" };
  }
  const root = value as Record<string, unknown>;
  if (
    !exactKeys(root, ["apiVersion", "files", "summary"]) ||
    root.apiVersion !== CANDIDATE_API_VERSION ||
    typeof root.summary !== "string" ||
    root.summary.trim().length === 0 ||
    root.summary.length > 2_000 ||
    !Array.isArray(root.files) ||
    root.files.length < 1 ||
    root.files.length > 8
  ) {
    return { rawOutputHash, errorCode: "CANDIDATE_SCHEMA_INVALID" };
  }
  const seen = new Set<string>();
  const files: CodeCandidate["files"] = [];
  let totalBytes = 0;
  for (const item of root.files) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return { rawOutputHash, errorCode: "CANDIDATE_SCHEMA_INVALID" };
    }
    const record = item as Record<string, unknown>;
    if (
      !exactKeys(record, ["path", "content"]) ||
      typeof record.path !== "string" ||
      typeof record.content !== "string" ||
      record.content.length === 0
    ) {
      return { rawOutputHash, errorCode: "CANDIDATE_SCHEMA_INVALID" };
    }
    if (
      !allowedPaths.includes(record.path) ||
      seen.has(record.path) ||
      record.path.includes("\\") ||
      record.path.startsWith("/") ||
      record.path.split("/").includes("..")
    ) {
      return { rawOutputHash, errorCode: "CANDIDATE_PATH_NOT_ALLOWED" };
    }
    seen.add(record.path);
    totalBytes += Buffer.byteLength(record.content, "utf8");
    if (totalBytes > MAX_CANDIDATE_BYTES) {
      return { rawOutputHash, errorCode: "CANDIDATE_SIZE_LIMIT" };
    }
    files.push({ path: record.path, content: record.content });
  }
  if (
    files.length !== allowedPaths.length ||
    allowedPaths.some((path) => !seen.has(path))
  ) {
    return { rawOutputHash, errorCode: "CANDIDATE_PATH_NOT_ALLOWED" };
  }
  const candidate: CodeCandidate = {
    apiVersion: CANDIDATE_API_VERSION,
    files,
    summary: root.summary.trim(),
  };
  const canonical = canonicalCandidateText(candidate);
  return {
    candidate,
    rawOutputHash,
    candidateHash: sha256(canonical),
  };
}

function filesText(
  files: Array<{ path: string; content: string }>,
): string {
  return files
    .map(
      ({ path, content }) =>
        `--- BEGIN ${path} ---\n${content}\n--- END ${path} ---`,
    )
    .join("\n\n");
}

export function buildCodeTaskPrompt(
  task: PublicCodeEvaluationTask,
  options: {
    priorCandidate?: CodeCandidate;
    stageRole?: "implementer" | "reviewer" | "final_reviewer";
  } = {},
): string {
  const stageRole = options.stageRole ?? "implementer";
  const roleInstruction =
    stageRole === "implementer"
      ? "Implement the requested maintenance ticket."
      : stageRole === "reviewer"
        ? "Review the previous candidate against every requirement and return a complete corrected candidate."
        : "Perform the final independent review and return the complete safest correct candidate.";
  const publicCases = structuredClone(task.publicCases);
  return [
    roleInstruction,
    "Return one JSON object only. Do not use Markdown fences.",
    `The apiVersion must be "${CANDIDATE_API_VERSION}".`,
    `Return exactly these complete files: ${JSON.stringify(task.editablePaths)}.`,
    "Do not add dependencies, network access, subprocesses, dynamic code execution, or test-specific branches.",
    "The editable module must export function solve(input). The harness supplies JSON-safe input and serializes the returned JSON-safe value.",
    "",
    `Ticket:\n${task.objective}`,
    "",
    `Public examples:\n${JSON.stringify(publicCases, null, 2)}`,
    "",
    `Repository files:\n${filesText(task.baseFiles)}`,
    ...(options.priorCandidate
      ? [
          "",
          "Previous candidate to review:",
          canonicalCandidateText(options.priorCandidate),
        ]
      : []),
    "",
    "Required response shape:",
    JSON.stringify(
      {
        apiVersion: CANDIDATE_API_VERSION,
        files: task.editablePaths.map((path) => ({
          path,
          content: "complete UTF-8 source",
        })),
        summary: "short implementation summary",
      },
      null,
      2,
    ),
  ].join("\n");
}
