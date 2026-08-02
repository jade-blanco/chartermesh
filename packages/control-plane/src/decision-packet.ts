import { createHash } from "node:crypto";
import type {
  AcceptanceCriterion,
  DecisionException,
  DecisionPacket,
  DecisionPacketEvidence,
  DecisionSubject,
  ToolExecutionEvidenceRecord,
  WorkItem,
  WorkItemDecisionContract,
} from "./types.ts";

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalValue(entry)]),
  );
}

export function canonicalHash(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalValue(value)))
    .digest("hex");
}

function cleanText(value: unknown, fallback: string, limit = 20_000): string {
  if (typeof value !== "string" || !value.trim()) return fallback;
  return value.trim().slice(0, limit);
}

function boundedStrings(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= 20 &&
    value.every(
      (entry) =>
        typeof entry === "string" &&
        entry.trim().length > 0 &&
        entry.length <= 1_000,
    )
  );
}

function parseProducerReport(content: string): DecisionPacket["producerReport"] {
  try {
    const value = JSON.parse(content) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    const allowedKeys = new Set([
      "apiVersion",
      "summary",
      "deliverable",
      "checks",
      "risks",
      "nextActions",
      "confidence",
    ]);
    if (
      Object.keys(record).some((key) => !allowedKeys.has(key)) ||
      record.apiVersion !== "chartermesh.dev/structured-artifact/v1alpha1" ||
      typeof record.summary !== "string" ||
      record.summary.trim().length === 0 ||
      record.summary.length > 2_000 ||
      typeof record.deliverable !== "string" ||
      record.deliverable.trim().length === 0 ||
      record.deliverable.length > 20_000 ||
      !boundedStrings(record.checks) ||
      !boundedStrings(record.risks) ||
      !boundedStrings(record.nextActions) ||
      !["low", "medium", "high"].includes(String(record.confidence))
    ) {
      return null;
    }
    return {
      source: "model_reported",
      summary: record.summary.trim(),
      deliverable: record.deliverable.trim(),
      reportedChecks: record.checks.map((entry) => entry.trim()),
      reportedRisks: record.risks.map((entry) => entry.trim()),
      nextActions: record.nextActions.map((entry) => entry.trim()),
      confidence: record.confidence as "low" | "medium" | "high",
    };
  } catch {
    return null;
  }
}

export function createDecisionContract(input: {
  objective: string;
  decisionQuestion?: string;
  acceptanceCriteria?: AcceptanceCriterion[];
  source?: WorkItemDecisionContract["source"];
}): WorkItemDecisionContract {
  const objective = cleanText(input.objective, "Review the requested work.", 4_000);
  const decisionQuestion = cleanText(
    input.decisionQuestion,
    `Does the submitted result satisfy this objective: ${objective}`,
    4_000,
  );
  const acceptanceCriteria = (input.acceptanceCriteria ?? []).slice(0, 100);
  const contractWithoutHash = {
    apiVersion: "chartermesh.dev/work-decision-contract/v1alpha1" as const,
    objective,
    decisionQuestion,
    acceptanceCriteria,
    reviewPolicy: "human_required" as const,
    source: input.source ?? "legacy_derived",
  };
  return {
    ...contractWithoutHash,
    contractHash: canonicalHash(contractWithoutHash),
  };
}

function evidenceStatus(
  status: ToolExecutionEvidenceRecord["status"],
): DecisionPacketEvidence["status"] {
  if (status === "succeeded") return "verified";
  if (status === "failed" || status === "denied") return "failed";
  return "unknown";
}

function subjectHash(subject: DecisionSubject): string {
  if (subject.kind === "artifact") return subject.artifactHash;
  if (subject.kind === "tool_call") return subject.callHash;
  return canonicalHash(subject.reference);
}

export function buildDecisionPacket(input: {
  workItem: WorkItem;
  contract: WorkItemDecisionContract;
  subject: DecisionSubject;
  artifactContent?: string;
  toolEvidence: ToolExecutionEvidenceRecord[];
  createdAt: string;
  question?: string;
}): DecisionPacket {
  const producerReport =
    input.subject.kind === "artifact" && input.artifactContent
      ? parseProducerReport(input.artifactContent)
      : null;
  const evidence: DecisionPacketEvidence[] = input.toolEvidence.map((entry) => ({
    id: entry.id,
    source: "tool_runtime",
    status: evidenceStatus(entry.status),
    description: `${entry.toolName} execution ${entry.status}.`,
    runId: entry.runId,
    attemptId: entry.attemptId,
    receiptId: entry.receiptId,
    provenance: entry.provenance,
    toolName: entry.toolName,
    inputHash: entry.inputHash,
    ...(entry.outputHash ? { outputHash: entry.outputHash } : {}),
    createdAt: entry.createdAt,
  }));
  if (producerReport) {
    producerReport.reportedChecks.forEach((description, index) => {
      evidence.push({
        id: `model-check:${index}:${canonicalHash(description).slice(0, 16)}`,
        source: "model_reported",
        status: "claimed",
        description,
        createdAt: input.createdAt,
      });
    });
  }
  evidence.push({
    id: `subject:${subjectHash(input.subject).slice(0, 24)}`,
    source: "control_plane",
    status: "verified",
    description:
      input.subject.kind === "artifact"
        ? "Control Plane bound this packet to the exact immutable artifact hash."
        : input.subject.kind === "tool_call"
          ? "Control Plane bound this packet to the exact pending tool-call hash."
          : "Control Plane bound this packet to the requested input reference.",
    createdAt: input.createdAt,
  });

  const criteria = input.contract.acceptanceCriteria.map((criterion) => {
    const requirementEvidence = criterion.evidenceRequirements.flatMap(
      (requirement) =>
        evidence.filter((entry) =>
          requirement.kind === "tool"
            ? entry.toolName === requirement.toolName &&
              entry.source === "tool_runtime"
            : entry.validatorId === requirement.validatorId &&
              entry.source === "host_validator",
        ),
    );
    const evidenceRefs = [...new Set(requirementEvidence.map(({ id }) => id))].sort();
    const failed = requirementEvidence.some(({ status }) => status === "failed");
    const satisfied =
      criterion.evidenceRequirements.length > 0 &&
      criterion.evidenceRequirements.every((requirement) =>
        evidence.some((entry) =>
          requirement.kind === "tool"
            ? entry.toolName === requirement.toolName &&
              entry.source === "tool_runtime" &&
              entry.status === "verified"
            : entry.validatorId === requirement.validatorId &&
              entry.source === "host_validator" &&
              entry.status === "verified",
        ),
      );
    return {
      criterionId: criterion.id,
      status: failed ? ("failed" as const) : satisfied ? ("satisfied" as const) : ("unverified" as const),
      evidenceRefs,
      explanation: failed
        ? "At least one required execution or validation failed."
        : satisfied
          ? "Every declared evidence requirement has verified evidence."
          : criterion.evidenceRequirements.length === 0
            ? "This criterion requires human judgment and was not auto-verified."
            : "One or more declared evidence requirements have no verified evidence.",
    };
  });

  const exceptions: DecisionException[] = [];
  if (input.contract.acceptanceCriteria.length === 0) {
    exceptions.push({
      code: "CONTRACT_INCOMPLETE",
      severity: "warning",
      owner: "human",
      message: "No explicit acceptance criteria were recorded for this legacy-derived request.",
      resolution: "Judge the original objective directly or request explicit acceptance criteria.",
      evidenceRefs: [],
    });
  }
  if (input.subject.kind === "artifact" && !producerReport) {
    exceptions.push({
      code: "ARTIFACT_UNSTRUCTURED",
      severity: "blocking",
      owner: "role",
      message: "The artifact cannot be projected into a bounded producer report.",
      resolution: "Submit a valid StructuredArtifact before requesting approval.",
      evidenceRefs: [],
    });
  }
  for (const criterion of input.contract.acceptanceCriteria) {
    const result = criteria.find(({ criterionId }) => criterionId === criterion.id);
    if (
      input.subject.kind !== "artifact" ||
      !criterion.critical ||
      criterion.evidenceRequirements.length === 0 ||
      result?.status === "satisfied"
    ) {
      continue;
    }
    exceptions.push({
      code: result?.status === "failed" ? "EVIDENCE_FAILED" : "EVIDENCE_MISSING",
      severity: "blocking",
      owner: "role",
      message: `${criterion.text}: ${result?.explanation ?? "No result was projected."}`,
      resolution: "Provide successful, hash-bound evidence or revise the result.",
      evidenceRefs: result?.evidenceRefs ?? [],
    });
  }
  for (const criterion of input.contract.acceptanceCriteria) {
    const result = criteria.find(({ criterionId }) => criterionId === criterion.id);
    if (
      input.subject.kind !== "artifact" ||
      !criterion.critical ||
      criterion.evidenceRequirements.length > 0 ||
      result?.status === "satisfied"
    ) {
      continue;
    }
    exceptions.push({
      code: "EVIDENCE_MISSING",
      severity: "warning",
      owner: "human",
      message: `${criterion.text}: this critical criterion requires human judgment and has no deterministic evidence requirement.`,
      resolution: "Judge the criterion directly or request a deterministic evidence requirement.",
      evidenceRefs: [],
    });
  }
  if (
    producerReport?.reportedChecks.length
  ) {
    exceptions.push({
      code: "MODEL_REPORTED_ONLY",
      severity: "warning",
      owner: "human",
      message: "Producer-reported checks remain claims because they are not individually linked to runtime or validator evidence.",
      resolution: "Inspect each claim or request explicitly linked executable evidence before approval.",
      evidenceRefs: evidence
        .filter(({ source }) => source === "model_reported")
        .map(({ id }) => id),
    });
  }
  if (producerReport?.confidence === "low") {
    exceptions.push({
      code: "LOW_CONFIDENCE",
      severity: "warning",
      owner: "human",
      message: "The producer rated its own confidence as low.",
      resolution: "Review the unresolved areas or request revision.",
      evidenceRefs: [],
    });
  }
  if (producerReport?.reportedRisks.length) {
    exceptions.push({
      code: "UNRESOLVED_RISK",
      severity: "warning",
      owner: "human",
      message: `${producerReport.reportedRisks.length} producer-reported risk item(s) remain.`,
      resolution: "Review every reported risk before deciding.",
      evidenceRefs: [],
    });
  }

  const exactSubjectHash = subjectHash(input.subject);
  const evidenceSetHash = canonicalHash(
    evidence
      .map(({ id, source, status, runId, attemptId, inputHash, outputHash, toolName, validatorId }) => ({
        id,
        source,
        status,
        runId: runId ?? null,
        attemptId: attemptId ?? null,
        inputHash: inputHash ?? null,
        outputHash: outputHash ?? null,
        toolName: toolName ?? null,
        validatorId: validatorId ?? null,
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  );
  const requestedDecision = {
    actor: "human" as const,
    options:
      input.subject.kind === "user_input"
        ? (["provide_input"] as const)
        : input.subject.kind === "tool_call"
          ? (["approve", "reject"] as const)
          : (["approve", "changes_requested", "reject"] as const),
    cta:
      input.subject.kind === "tool_call"
        ? "Review the exact tool change and decide whether it may execute."
        : input.subject.kind === "artifact"
          ? "Review the result, evidence strength, and unresolved exceptions."
          : "Provide the requested input.",
  };
  const packetWithoutHash = {
    projectionVersion: "v1alpha1" as const,
    workItemId: input.workItem.id,
    contractHash: input.contract.contractHash,
    subjectHash: exactSubjectHash,
    evidenceSetHash,
    workItemVersion: input.workItem.version,
    question: cleanText(
      input.question,
      input.contract.decisionQuestion,
      4_000,
    ),
    criteria,
    exceptions: exceptions.map(({ code, severity, owner, evidenceRefs }) => ({
      code,
      severity,
      owner,
      evidenceRefs: [...evidenceRefs].sort(),
    })),
  };
  return {
    apiVersion: "chartermesh.dev/decision-packet/v1alpha1",
    workItemId: input.workItem.id,
    kind:
      input.subject.kind === "artifact"
        ? "artifact_review"
        : input.subject.kind === "tool_call"
          ? "tool_execution"
          : "user_input",
    question: cleanText(
      input.question,
      input.contract.decisionQuestion,
      4_000,
    ),
    subject: input.subject,
    producerReport,
    criteria,
    evidence,
    exceptions,
    requestedDecision: {
      ...requestedDecision,
      options: [...requestedDecision.options],
    },
    binding: {
      contractHash: input.contract.contractHash,
      subjectHash: exactSubjectHash,
      evidenceSetHash,
      workItemVersion: input.workItem.version,
      projectionVersion: "v1alpha1",
      packetHash: canonicalHash(packetWithoutHash),
    },
  };
}
