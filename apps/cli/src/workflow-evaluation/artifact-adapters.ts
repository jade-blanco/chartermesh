import { createHash } from "node:crypto";
import {
  ARTIFACT_CELL_REFERENCE_PATTERN,
  ARTIFACT_CANDIDATE_API_VERSION,
  ARTIFACT_COLUMN_KEY_PATTERN,
  ARTIFACT_IDENTIFIER_PATTERN,
  ARTIFACT_ISO_DATE_PATTERN,
  ARTIFACT_HTTPS_URL_PATTERN,
  canonicalArtifactJson,
  evaluateArtifactOracle,
  parseArtifactCandidate,
  type ArtifactCandidateEnvelope,
  type ArtifactIr,
} from "./artifacts.ts";
import {
  projectPublicArtifactTask,
  type ArtifactEvaluationTask,
  type PublicArtifactEvaluationTask,
} from "./suite.ts";
import type {
  SealedWorkflowEvaluator,
  WorkflowPublicTask,
} from "./types.ts";

export function artifactFamilyContract(
  family: PublicArtifactEvaluationTask["family"],
): string {
  switch (family) {
    case "product_package":
      return "artifact={kind,name,positioning:{audience,problem,promise},deliverables:[{id,name,acceptance:[string]}],launchChecklist:[{id,owner,done:boolean}]}";
    case "research":
      return "artifact={kind,question,sources:[{id,title,url,publishedDate}],findings:[{id,claim,sourceIds:[string],confidence:low|medium|high}],limitations:[string]}";
    case "xlsx":
      return "artifact={kind,workbookTitle,sheets:[{name,columns:[{key,header,type:text|number|date|boolean|currency}],rows:[{cells:[{columnKey,value:primitive}]}],formulas:[{cell,expression,dependsOn:[string]}]}],namedRanges:[string]}";
    case "docx":
      return "artifact={kind,title,audience,sections:[{id,heading,blocks:[paragraph|bullets|table]}],reviewChecklist:[string]}; paragraph={type:paragraph,text}; bullets={type:bullets,items:[string]}; table={type:table,headers:[string],rows:[[string]]}";
    case "pptx":
      return "artifact={kind,title,theme,slides:[{id,title,purpose,body:bullets|metric|timeline,speakerNotes}],narrative:[string]}; bullets={type:bullets,items:[string]}; metric={type:metric,label,value,context}; timeline={type:timeline,milestones:[{label,date}]}";
  }
}

function textSchema(
  maxLength: number,
  options: { pattern?: string; allowEmpty?: boolean } = {},
): Record<string, unknown> {
  return {
    type: "string",
    minLength: options.allowEmpty ? 0 : 1,
    maxLength,
    ...(options.pattern ? { pattern: options.pattern } : {}),
  };
}

function stringListSchema(
  maxItems: number,
  options: {
    minItems?: number;
    itemMaxLength?: number;
    itemPattern?: string;
  } = {},
): Record<string, unknown> {
  return {
    type: "array",
    ...(options.minItems === undefined
      ? {}
      : { minItems: options.minItems }),
    maxItems,
    items: textSchema(options.itemMaxLength ?? 4_096, {
      ...(options.itemPattern ? { pattern: options.itemPattern } : {}),
    }),
  };
}

const identifierText = textSchema(64, {
  pattern: ARTIFACT_IDENTIFIER_PATTERN,
});
const columnKeyText = textSchema(64, {
  pattern: ARTIFACT_COLUMN_KEY_PATTERN,
});
const cellReferenceText = textSchema(12, {
  pattern: ARTIFACT_CELL_REFERENCE_PATTERN,
});

function familyArtifactSchema(
  family: PublicArtifactEvaluationTask["family"],
): Record<string, unknown> {
  const product = {
    type: "object",
    additionalProperties: false,
    required: ["kind", "name", "positioning", "deliverables", "launchChecklist"],
    properties: {
      kind: { const: "product_package" },
      name: textSchema(160),
      positioning: {
        type: "object",
        additionalProperties: false,
        required: ["audience", "problem", "promise"],
        properties: {
          audience: textSchema(1_000),
          problem: textSchema(2_000),
          promise: textSchema(2_000),
        },
      },
      deliverables: {
        type: "array",
        minItems: 1,
        maxItems: 64,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "name", "acceptance"],
          properties: {
            id: identifierText,
            name: textSchema(240),
            acceptance: stringListSchema(32, { minItems: 1 }),
          },
        },
      },
      launchChecklist: {
        type: "array",
        minItems: 1,
        maxItems: 64,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "owner", "done"],
          properties: {
            id: identifierText,
            owner: textSchema(160),
            done: { type: "boolean" },
          },
        },
      },
    },
  };
  const research = {
    type: "object",
    additionalProperties: false,
    required: ["kind", "question", "sources", "findings", "limitations"],
    properties: {
      kind: { const: "research" },
      question: textSchema(2_000),
      sources: {
        type: "array",
        minItems: 1,
        maxItems: 128,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "title", "url", "publishedDate"],
          properties: {
            id: identifierText,
            title: textSchema(500),
            url: {
              type: "string",
              minLength: 9,
              maxLength: 2_048,
              pattern: ARTIFACT_HTTPS_URL_PATTERN,
            },
            publishedDate: textSchema(10, {
              pattern: ARTIFACT_ISO_DATE_PATTERN,
            }),
          },
        },
      },
      findings: {
        type: "array",
        minItems: 1,
        maxItems: 128,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "claim", "sourceIds", "confidence"],
          properties: {
            id: identifierText,
            claim: textSchema(4_000),
            sourceIds: stringListSchema(32, {
              minItems: 1,
              itemMaxLength: 64,
              itemPattern: ARTIFACT_IDENTIFIER_PATTERN,
            }),
            confidence: { enum: ["low", "medium", "high"] },
          },
        },
      },
      limitations: stringListSchema(64),
    },
  };
  const xlsx = {
    type: "object",
    additionalProperties: false,
    required: ["kind", "workbookTitle", "sheets", "namedRanges"],
    properties: {
      kind: { const: "xlsx" },
      workbookTitle: textSchema(240),
      sheets: {
        type: "array",
        minItems: 1,
        maxItems: 64,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["name", "columns", "rows", "formulas"],
          properties: {
            name: textSchema(31),
            columns: {
              type: "array",
              minItems: 1,
              maxItems: 128,
              items: {
                type: "object",
                additionalProperties: false,
                required: ["key", "header", "type"],
                properties: {
                  key: columnKeyText,
                  header: textSchema(240),
                  type: { enum: ["text", "number", "date", "boolean", "currency"] },
                },
              },
            },
            rows: {
              type: "array",
              maxItems: 512,
              items: {
                type: "object",
                additionalProperties: false,
                required: ["cells"],
                properties: {
                  cells: {
                    type: "array",
                    maxItems: 128,
                    items: {
                      type: "object",
                      additionalProperties: false,
                      required: ["columnKey", "value"],
                      properties: {
                        columnKey: columnKeyText,
                        value: {
                          oneOf: [
                            { type: "string", maxLength: 4_000 },
                            { type: "number" },
                            { type: "boolean" },
                            { type: "null" },
                          ],
                        },
                      },
                    },
                  },
                },
              },
            },
            formulas: {
              type: "array",
              maxItems: 128,
              items: {
                type: "object",
                additionalProperties: false,
                required: ["cell", "expression", "dependsOn"],
                properties: {
                  cell: cellReferenceText,
                  expression: textSchema(1_000),
                  dependsOn: stringListSchema(128),
                },
              },
            },
          },
        },
      },
      namedRanges: stringListSchema(128),
    },
  };
  const docxBlock = {
    oneOf: [
      {
        type: "object",
        additionalProperties: false,
        required: ["type", "text"],
        properties: { type: { const: "paragraph" }, text: textSchema(12_000) },
      },
      {
        type: "object",
        additionalProperties: false,
        required: ["type", "items"],
        properties: {
          type: { const: "bullets" },
          items: stringListSchema(128, { minItems: 1 }),
        },
      },
      {
        type: "object",
        additionalProperties: false,
        required: ["type", "headers", "rows"],
        properties: {
          type: { const: "table" },
          headers: stringListSchema(32, { minItems: 1 }),
          rows: {
            type: "array",
            minItems: 1,
            maxItems: 128,
            items: stringListSchema(32),
          },
        },
      },
    ],
  };
  const docx = {
    type: "object",
    additionalProperties: false,
    required: ["kind", "title", "audience", "sections", "reviewChecklist"],
    properties: {
      kind: { const: "docx" },
      title: textSchema(240),
      audience: textSchema(1_000),
      sections: {
        type: "array",
        minItems: 1,
        maxItems: 128,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "heading", "blocks"],
          properties: {
            id: identifierText,
            heading: textSchema(500),
            blocks: { type: "array", minItems: 1, maxItems: 128, items: docxBlock },
          },
        },
      },
      reviewChecklist: stringListSchema(128),
    },
  };
  const pptxBody = {
    oneOf: [
      {
        type: "object",
        additionalProperties: false,
        required: ["type", "items"],
        properties: {
          type: { const: "bullets" },
          items: stringListSchema(32, { minItems: 1 }),
        },
      },
      {
        type: "object",
        additionalProperties: false,
        required: ["type", "label", "value", "context"],
        properties: {
          type: { const: "metric" },
          label: textSchema(240),
          value: textSchema(120),
          context: textSchema(1_000),
        },
      },
      {
        type: "object",
        additionalProperties: false,
        required: ["type", "milestones"],
        properties: {
          type: { const: "timeline" },
          milestones: {
            type: "array",
            minItems: 1,
            maxItems: 32,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["label", "date"],
              properties: {
                label: textSchema(240),
                date: textSchema(40),
              },
            },
          },
        },
      },
    ],
  };
  const pptx = {
    type: "object",
    additionalProperties: false,
    required: ["kind", "title", "theme", "slides", "narrative"],
    properties: {
      kind: { const: "pptx" },
      title: textSchema(240),
      theme: textSchema(240),
      slides: {
        type: "array",
        minItems: 1,
        maxItems: 128,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "title", "purpose", "body", "speakerNotes"],
          properties: {
            id: identifierText,
            title: textSchema(240),
            purpose: textSchema(1_000),
            body: pptxBody,
            speakerNotes: textSchema(8_000),
          },
        },
      },
      narrative: stringListSchema(128),
    },
  };
  return { product_package: product, research, xlsx, docx, pptx }[family];
}

export function artifactCandidateResponseSchemaFor(
  task: Pick<PublicArtifactEvaluationTask, "id" | "family">,
): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["apiVersion", "taskId", "artifact"],
    properties: {
      apiVersion: { const: ARTIFACT_CANDIDATE_API_VERSION },
      taskId: { const: task.id },
      artifact: familyArtifactSchema(task.family),
    },
  };
}

/** Generic discovery schema; live generation uses the task-bound function. */
export const artifactCandidateResponseSchema = {
  oneOf: ["product_package", "research", "xlsx", "docx", "pptx"].map(
    (family) =>
      artifactCandidateResponseSchemaFor({
        id: "replace-with-task-id",
        family: family as PublicArtifactEvaluationTask["family"],
      }),
  ),
} satisfies Record<string, unknown>;

export function workflowTaskFromArtifactTask(
  task: ArtifactEvaluationTask,
): WorkflowPublicTask {
  const publicTask = projectPublicArtifactTask(task);
  return {
    id: publicTask.id,
    family: publicTask.family,
    difficulty: publicTask.difficulty,
    objective: publicTask.objective,
    initialImplementationBrief: [
      publicTask.objective,
      ...publicTask.publicInstructions.map((item) => `- ${item}`),
      `Return exactly one ${ARTIFACT_CANDIDATE_API_VERSION} JSON object for taskId=${publicTask.id}.`,
      `artifact.kind must be ${publicTask.family}.`,
      "This evaluates bounded semantic IR only. Do not return OOXML, ZIP, HTML, Markdown, a code fence, or explanatory prose.",
    ].join("\n"),
    publicContext: [
      "The evaluation is offline and forbids external side effects.",
      "The candidate is declarative data and will never be executed.",
      "Document-family candidates do not establish Office rendering or visual fidelity.",
    ],
    acceptanceCriteria: [...publicTask.publicInstructions],
    artifactKind: publicTask.outputContract.artifactKind,
  };
}

export function artifactCandidatePrompt(input: {
  task: PublicArtifactEvaluationTask;
  orientation: string;
  submission: number;
  directive: string;
  previousArtifact: string | null;
}): string {
  return [
    `Objective:\n${input.task.objective}`,
    `Public requirements:\n- ${input.task.publicInstructions.join("\n- ")}`,
    `Matched orientation plan:\n${input.orientation}`,
    input.previousArtifact
      ? `Previous immutable candidate to revise:\n${input.previousArtifact}`
      : "No previous candidate exists.",
    `Current simulated-user directive:\n${input.directive}`,
    `Submission number: ${input.submission}`,
    `Required envelope: {"apiVersion":"${ARTIFACT_CANDIDATE_API_VERSION}","taskId":"${input.task.id}","artifact":...}`,
    `Family-specific IR contract:\n${artifactFamilyContract(input.task.family)}`,
    "Return one strict JSON object only, without a code fence or surrounding text.",
    "Use every field in the family contract and no undeclared fields. JSON keys and enum values are case-sensitive.",
    "Do not claim that an Office binary, live web research, external action, or hidden validation was performed.",
  ].join("\n\n");
}

function renderProduct(artifact: Extract<ArtifactIr, { kind: "product_package" }>): string {
  return [
    artifact.name,
    `대상: ${artifact.positioning.audience}`,
    `문제: ${artifact.positioning.problem}`,
    `약속: ${artifact.positioning.promise}`,
    "산출물:",
    ...artifact.deliverables.map(
      (item) =>
        `- ${item.name}: ${item.acceptance.join(" / ")}`,
    ),
    "출시 점검:",
    ...artifact.launchChecklist.map(
      (item) => `- ${item.id} (${item.owner}): ${item.done ? "완료" : "미완료"}`,
    ),
  ].join("\n");
}

function renderResearch(artifact: Extract<ArtifactIr, { kind: "research" }>): string {
  return [
    `질문: ${artifact.question}`,
    "조사 결과:",
    ...artifact.findings.map(
      (item) =>
        `- ${item.claim} [출처 ${item.sourceIds.join(", ")}; 신뢰도 ${item.confidence}]`,
    ),
    "공개 출처:",
    ...artifact.sources.map(
      (item) => `- ${item.id}: ${item.title} (${item.publishedDate})`,
    ),
    "한계:",
    ...artifact.limitations.map((item) => `- ${item}`),
  ].join("\n");
}

function renderXlsx(artifact: Extract<ArtifactIr, { kind: "xlsx" }>): string {
  const sections = artifact.sheets.flatMap((sheet) => [
    `시트: ${sheet.name}`,
    `열: ${sheet.columns.map((column) => column.header).join(" | ")}`,
    ...sheet.rows.slice(0, 20).map((row) =>
      sheet.columns
        .map((column) =>
          String(
            row.cells.find(
              (cell) => cell.columnKey === column.key,
            )?.value ?? "",
          ),
        )
        .join(" | "),
    ),
    ...sheet.formulas.map(
      (formula) =>
        `수식 명세 ${formula.cell}: ${formula.expression} (참조 ${formula.dependsOn.join(", ")})`,
    ),
  ]);
  return [
    `워크북: ${artifact.workbookTitle}`,
    ...sections,
    `이름 범위: ${artifact.namedRanges.join(", ") || "없음"}`,
    "주의: 이는 의미 구조 미리보기이며 실제 XLSX 렌더링 결과가 아닙니다.",
  ].join("\n");
}

function renderDocx(artifact: Extract<ArtifactIr, { kind: "docx" }>): string {
  const sections = artifact.sections.flatMap((section) => [
    `## ${section.heading}`,
    ...section.blocks.map((block) => {
      if (block.type === "paragraph") return block.text;
      if (block.type === "bullets") {
        return block.items.map((item) => `- ${item}`).join("\n");
      }
      return [
        block.headers.join(" | "),
        ...block.rows.map((row) => row.join(" | ")),
      ].join("\n");
    }),
  ]);
  return [
    `문서: ${artifact.title}`,
    `독자: ${artifact.audience}`,
    ...sections,
    "검토 항목:",
    ...artifact.reviewChecklist.map((item) => `- ${item}`),
    "주의: 이는 의미 구조 미리보기이며 실제 DOCX 페이지 렌더링이 아닙니다.",
  ].join("\n");
}

function renderPptx(artifact: Extract<ArtifactIr, { kind: "pptx" }>): string {
  const slides = artifact.slides.flatMap((slide, index) => {
    const body =
      slide.body.type === "bullets"
        ? slide.body.items.map((item) => `- ${item}`).join("\n")
        : slide.body.type === "metric"
          ? `${slide.body.label}: ${slide.body.value} — ${slide.body.context}`
          : slide.body.milestones
              .map((item) => `${item.date}: ${item.label}`)
              .join("\n");
    return [
      `슬라이드 ${index + 1}: ${slide.title}`,
      `목적: ${slide.purpose}`,
      body,
      `발표자 노트: ${slide.speakerNotes}`,
    ];
  });
  return [
    `프레젠테이션: ${artifact.title} (${artifact.theme})`,
    ...slides,
    `전체 흐름: ${artifact.narrative.join(" → ")}`,
    "주의: 이는 의미 구조 미리보기이며 실제 PPTX 시각 렌더링이 아닙니다.",
  ].join("\n");
}

export function renderArtifactCandidateForHuman(
  candidate: ArtifactCandidateEnvelope,
): string {
  switch (candidate.artifact.kind) {
    case "product_package":
      return renderProduct(candidate.artifact);
    case "research":
      return renderResearch(candidate.artifact);
    case "xlsx":
      return renderXlsx(candidate.artifact);
    case "docx":
      return renderDocx(candidate.artifact);
    case "pptx":
      return renderPptx(candidate.artifact);
  }
}

export class ArtifactTaskSealedEvaluator
  implements SealedWorkflowEvaluator
{
  readonly id: string;
  readonly #task: ArtifactEvaluationTask;

  constructor(task: ArtifactEvaluationTask) {
    this.#task = task;
    this.id = `artifact-oracle:${task.taskHash}`;
  }

  async evaluate(input: {
    taskId: string;
    artifact: string;
    artifactHash: string;
  }) {
    if (input.taskId !== this.#task.id) {
      throw new Error("SEALED_EVALUATOR_TASK_MISMATCH");
    }
    const observedHash = createHash("sha256")
      .update(input.artifact)
      .digest("hex");
    if (observedHash !== input.artifactHash) {
      throw new Error("SEALED_EVALUATOR_ARTIFACT_HASH_MISMATCH");
    }
    const candidate = parseArtifactCandidate(input.artifact, {
      taskId: this.#task.id,
      family: this.#task.family,
    });
    if (canonicalArtifactJson(candidate) !== input.artifact) {
      throw new Error("SEALED_EVALUATOR_REQUIRES_CANONICAL_ARTIFACT");
    }
    const result = evaluateArtifactOracle(
      candidate.artifact,
      this.#task.oracleRequirements,
    );
    const total = result.checks.length;
    return {
      passed: result.passed,
      score:
        total === 0
          ? 0
          : result.passedRequirementIds.length / total,
      criticalFailures: [...result.failedRequirementIds],
      criterionResults: result.checks.map((check) => ({
        id: check.requirementId,
        passed: check.passed,
        score: check.passed ? 1 : 0,
      })),
    };
  }
}
