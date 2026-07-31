import {
  ARTIFACT_CANDIDATE_API_VERSION,
  canonicalArtifactSha256,
  evaluateArtifactOracle,
  validateArtifactCandidateEnvelope,
  type ArtifactCandidateEnvelope,
  type ArtifactDifficulty,
  type ArtifactFamily,
  type ArtifactIr,
  type ArtifactOracleRequirement,
  type DocxIr,
  type PptxIr,
  type ProductPackageIr,
  type ResearchIr,
  type XlsxIr,
} from "./artifacts.ts";

export const WORKFLOW_ARTIFACT_SUITE_API_VERSION =
  "chartermesh.dev/workflow-artifact-suite/v1alpha1" as const;
const DEFAULT_ARTIFACT_SUITE_SEED = 20260731;

export interface ArtifactMutation {
  id: string;
  description: string;
  candidate: ArtifactCandidateEnvelope;
  candidateHash: string;
  selectionHash: string;
}

export interface ArtifactEvaluationTask {
  apiVersion: typeof WORKFLOW_ARTIFACT_SUITE_API_VERSION;
  id: string;
  family: ArtifactFamily;
  difficulty: ArtifactDifficulty;
  objective: string;
  publicInstructions: string[];
  oracleRequirements: ArtifactOracleRequirement[];
  oracleCandidate: ArtifactCandidateEnvelope;
  baselineCandidate: ArtifactCandidateEnvelope;
  baselineExpectedFailureRequirementIds: string[];
  mutations: ArtifactMutation[];
  taskHash: string;
}

export interface PublicArtifactEvaluationTask {
  apiVersion: typeof WORKFLOW_ARTIFACT_SUITE_API_VERSION;
  id: string;
  family: ArtifactFamily;
  difficulty: ArtifactDifficulty;
  objective: string;
  publicInstructions: string[];
  outputContract: {
    apiVersion: typeof ARTIFACT_CANDIDATE_API_VERSION;
    taskId: string;
    artifactKind: ArtifactFamily;
    format: "single-json-object";
    maximumBytes: 262144;
    semanticGateOnly: true;
  };
}

export interface SealedArtifactEvaluationTask {
  apiVersion: typeof WORKFLOW_ARTIFACT_SUITE_API_VERSION;
  publicTask: PublicArtifactEvaluationTask;
  oracleRequirements: ArtifactOracleRequirement[];
  oracleCandidate: ArtifactCandidateEnvelope;
  baselineCandidate: ArtifactCandidateEnvelope;
  baselineExpectedFailureRequirementIds: string[];
  mutations: ArtifactMutation[];
  taskHash: string;
}

interface MutationDraft {
  id: string;
  description: string;
  artifact: ArtifactIr;
}

interface Blueprint {
  objective: string;
  publicInstructions: string[];
  oracle: ArtifactIr;
  baseline: ArtifactIr;
  requirements: ArtifactOracleRequirement[];
  baselineExpectedFailureRequirementIds: string[];
  mutationDrafts: MutationDraft[];
}

const FAMILIES: readonly ArtifactFamily[] = [
  "product_package",
  "research",
  "xlsx",
  "docx",
  "pptx",
];
const DIFFICULTIES: readonly ArtifactDifficulty[] = ["easy", "medium", "hard"];

const LEVEL = {
  easy: { ordinal: 1, label: "Starter" },
  medium: { ordinal: 2, label: "Operations" },
  hard: { ordinal: 3, label: "Executive" },
} as const;

function candidate(taskId: string, artifact: ArtifactIr): ArtifactCandidateEnvelope {
  return validateArtifactCandidateEnvelope(
    {
      apiVersion: ARTIFACT_CANDIDATE_API_VERSION,
      taskId,
      artifact,
    },
    { taskId, family: artifact.kind },
  );
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function productBlueprint(difficulty: ArtifactDifficulty): Blueprint {
  const level = LEVEL[difficulty];
  const count = level.ordinal + 1;
  const name = `${level.label} Launch Kit`;
  const audience = `${level.label.toLowerCase()}-stage service operators`;
  const criticalAcceptance = `Activation metric is defined for ${difficulty} rollout`;
  const owner = difficulty === "hard" ? "chief-operating-officer" : "product-lead";
  const oracle: ProductPackageIr = {
    kind: "product_package",
    name,
    positioning: {
      audience,
      problem: `Teams need a repeatable ${difficulty} launch package.`,
      promise: "Ship a measurable offer without losing owner accountability.",
    },
    deliverables: Array.from({ length: count }, (_, index) => ({
      id: `deliverable-${index + 1}`,
      name: index === 0 ? "Activation offer" : `Launch asset ${index + 1}`,
      acceptance:
        index === 0
          ? [criticalAcceptance, "Owner and due date are explicit"]
          : [`Asset ${index + 1} has a measurable acceptance check`],
    })),
    launchChecklist: Array.from({ length: count }, (_, index) => ({
      id: `check-${index + 1}`,
      owner: index === 0 ? owner : `owner-${index + 1}`,
      done: false,
    })),
  };
  const baseline = clone(oracle);
  baseline.positioning.audience = "everyone";
  baseline.deliverables.pop();
  baseline.deliverables[0]!.acceptance = ["Looks complete"];
  baseline.launchChecklist.pop();
  const requirements: ArtifactOracleRequirement[] = [
    { id: "product-name", path: "/name", operator: "equals", expected: name },
    { id: "target-audience", path: "/positioning/audience", operator: "equals", expected: audience },
    { id: "deliverable-coverage", path: "/deliverables", operator: "min_items", expected: count },
    { id: "deliverable-identities", path: "/deliverables", operator: "unique_by", key: "id" },
    { id: "critical-acceptance", path: "/deliverables/0/acceptance", operator: "contains", expected: criticalAcceptance },
    { id: "checklist-coverage", path: "/launchChecklist", operator: "min_items", expected: count },
    { id: "accountable-owner", path: "/launchChecklist/0/owner", operator: "equals", expected: owner },
  ];
  const wrongName = clone(oracle);
  wrongName.name = "Generic Launch Kit";
  const wrongAudience = clone(oracle);
  wrongAudience.positioning.audience = "all users";
  const missingDeliverable = clone(oracle);
  missingDeliverable.deliverables.pop();
  const missingAcceptance = clone(oracle);
  missingAcceptance.deliverables[0]!.acceptance = ["Owner and due date are explicit"];
  const missingChecklist = clone(oracle);
  missingChecklist.launchChecklist.pop();
  return {
    objective: `Create the ${difficulty} product launch package for a service-operations team.`,
    publicInstructions: [
      `Name the package “${name}” and target ${audience}.`,
      `Provide at least ${count} deliverables and ${count} accountable launch checks.`,
      `The first deliverable must state: “${criticalAcceptance}”.`,
      `Assign the first launch check to ${owner}.`,
    ],
    oracle,
    baseline,
    requirements,
    baselineExpectedFailureRequirementIds: [
      "target-audience",
      "deliverable-coverage",
      "critical-acceptance",
      "checklist-coverage",
    ],
    mutationDrafts: [
      { id: "wrong-product-name", description: "Uses the wrong package name.", artifact: wrongName },
      { id: "wrong-audience", description: "Targets a generic audience.", artifact: wrongAudience },
      { id: "missing-deliverable", description: "Omits one required deliverable.", artifact: missingDeliverable },
      { id: "missing-acceptance", description: "Drops the activation acceptance criterion.", artifact: missingAcceptance },
      { id: "missing-check", description: "Omits one accountable launch check.", artifact: missingChecklist },
    ],
  };
}

function researchBlueprint(difficulty: ArtifactDifficulty): Blueprint {
  const level = LEVEL[difficulty];
  const count = level.ordinal + 1;
  const question = `Which ${difficulty} adoption barrier should the service team address first?`;
  const criticalLimitation = `The ${difficulty} sample does not establish causality.`;
  const oracle: ResearchIr = {
    kind: "research",
    question,
    sources: Array.from({ length: count }, (_, index) => ({
      id: `source-${index + 1}`,
      title: `${level.label} evidence source ${index + 1}`,
      url: `https://evidence.example.org/${difficulty}/source-${index + 1}`,
      publishedDate: `2026-0${index + 1}-15`,
    })),
    findings: Array.from({ length: count }, (_, index) => ({
      id: `finding-${index + 1}`,
      claim: `Observed ${difficulty} adoption signal ${index + 1}.`,
      sourceIds: ["source-1"],
      confidence: index === 0 ? "high" : "medium",
    })),
    limitations: [criticalLimitation, ...(difficulty === "easy" ? [] : ["Results may vary by operating region."])],
  };
  const baseline = clone(oracle);
  baseline.question = "What should we do?";
  baseline.sources.pop();
  baseline.findings.pop();
  baseline.limitations = ["More work may be needed."];
  const requirements: ArtifactOracleRequirement[] = [
    { id: "research-question", path: "/question", operator: "equals", expected: question },
    { id: "source-coverage", path: "/sources", operator: "min_items", expected: count },
    { id: "source-identities", path: "/sources", operator: "unique_by", key: "id" },
    { id: "finding-coverage", path: "/findings", operator: "min_items", expected: count },
    { id: "finding-identities", path: "/findings", operator: "unique_by", key: "id" },
    { id: "primary-evidence", path: "/findings/0/sourceIds", operator: "contains", expected: "source-1" },
    { id: "critical-limitation", path: "/limitations", operator: "contains", expected: criticalLimitation },
  ];
  const wrongQuestion = clone(oracle);
  wrongQuestion.question = "Which option is popular?";
  const missingSource = clone(oracle);
  missingSource.sources.pop();
  const missingFinding = clone(oracle);
  missingFinding.findings.pop();
  const wrongEvidence = clone(oracle);
  wrongEvidence.findings[0]!.sourceIds = ["source-2"];
  const missingLimitation = clone(oracle);
  missingLimitation.limitations = missingLimitation.limitations.filter((item) => item !== criticalLimitation);
  return {
    objective: `Produce a source-linked ${difficulty} research brief about service adoption.`,
    publicInstructions: [
      `Answer exactly this question: “${question}”`,
      `Use at least ${count} HTTPS sources and ${count} source-linked findings.`,
      "The first finding must cite source-1.",
      `State the limitation: “${criticalLimitation}”`,
    ],
    oracle,
    baseline,
    requirements,
    baselineExpectedFailureRequirementIds: [
      "research-question",
      "source-coverage",
      "finding-coverage",
      "critical-limitation",
    ],
    mutationDrafts: [
      { id: "wrong-question", description: "Answers a different research question.", artifact: wrongQuestion },
      { id: "missing-source", description: "Omits one required source.", artifact: missingSource },
      { id: "missing-finding", description: "Omits one required finding.", artifact: missingFinding },
      { id: "wrong-evidence-link", description: "Breaks the primary evidence link.", artifact: wrongEvidence },
      { id: "missing-limitation", description: "Omits the causal limitation.", artifact: missingLimitation },
    ],
  };
}

function xlsxBlueprint(difficulty: ArtifactDifficulty): Blueprint {
  const level = LEVEL[difficulty];
  const rowCount = level.ordinal + 1;
  const sheetCount = level.ordinal;
  const title = `${level.label} Service Operations Workbook`;
  const firstSheet = `${level.label} Tracker`;
  const formula = "=SUM(C2:C99)";
  const range = `${level.label.replaceAll(" ", "")}_Input`;
  const columns: XlsxIr["sheets"][number]["columns"] = [
    { key: "item", header: "Work item", type: "text" },
    { key: "owner", header: "Owner", type: "text" },
    { key: "amount", header: "Amount", type: "currency" },
  ];
  const oracle: XlsxIr = {
    kind: "xlsx",
    workbookTitle: title,
    sheets: Array.from({ length: sheetCount }, (_, sheetIndex) => ({
      name: sheetIndex === 0 ? firstSheet : `Supporting ${sheetIndex + 1}`,
      columns: clone(columns),
      rows: Array.from({ length: rowCount }, (_, rowIndex) => ({
        cells: [
          { columnKey: "item", value: `Work ${rowIndex + 1}` },
          { columnKey: "owner", value: `Owner ${rowIndex + 1}` },
          { columnKey: "amount", value: (rowIndex + 1) * 100 },
        ],
      })),
      formulas:
        sheetIndex === 0
          ? [{ cell: "C100", expression: formula, dependsOn: ["C2:C99"] }]
          : [],
    })),
    namedRanges: [range],
  };
  const baseline = clone(oracle);
  baseline.workbookTitle = "Untitled Workbook";
  baseline.sheets[0]!.rows.pop();
  baseline.sheets[0]!.formulas[0]!.expression = "=C2";
  baseline.namedRanges = [];
  const requirements: ArtifactOracleRequirement[] = [
    { id: "workbook-title", path: "/workbookTitle", operator: "equals", expected: title },
    { id: "sheet-coverage", path: "/sheets", operator: "min_items", expected: sheetCount },
    { id: "sheet-identities", path: "/sheets", operator: "unique_by", key: "name" },
    { id: "tracker-name", path: "/sheets/0/name", operator: "equals", expected: firstSheet },
    { id: "row-coverage", path: "/sheets/0/rows", operator: "min_items", expected: rowCount },
    { id: "total-formula", path: "/sheets/0/formulas/0/expression", operator: "equals", expected: formula },
    { id: "input-range", path: "/namedRanges", operator: "contains", expected: range },
  ];
  const wrongTitle = clone(oracle);
  wrongTitle.workbookTitle = "Service Workbook";
  const wrongSheet = clone(oracle);
  wrongSheet.sheets[0]!.name = "Sheet1";
  const missingRow = clone(oracle);
  missingRow.sheets[0]!.rows.pop();
  const wrongFormula = clone(oracle);
  wrongFormula.sheets[0]!.formulas[0]!.expression = "=AVERAGE(C2:C99)";
  const missingRange = clone(oracle);
  missingRange.namedRanges = [];
  return {
    objective: `Design the semantic IR for a ${difficulty} service-operations workbook.`,
    publicInstructions: [
      `Title the workbook “${title}” with at least ${sheetCount} sheet(s).`,
      `Name the first sheet “${firstSheet}” and include at least ${rowCount} data rows.`,
      `Put the formula “${formula}” in C100 of the first sheet.`,
      `Define the named range “${range}”.`,
      "Return workbook IR only; OOXML rendering is outside this v1 fixture.",
    ],
    oracle,
    baseline,
    requirements,
    baselineExpectedFailureRequirementIds: ["workbook-title", "row-coverage", "total-formula", "input-range"],
    mutationDrafts: [
      { id: "wrong-workbook-title", description: "Uses an incorrect workbook title.", artifact: wrongTitle },
      { id: "wrong-tracker-name", description: "Uses a generic tracker sheet name.", artifact: wrongSheet },
      { id: "missing-workbook-row", description: "Omits one required data row.", artifact: missingRow },
      { id: "wrong-total-formula", description: "Uses a different aggregation formula.", artifact: wrongFormula },
      { id: "missing-input-range", description: "Omits the named input range.", artifact: missingRange },
    ],
  };
}

function docxBlueprint(difficulty: ArtifactDifficulty): Blueprint {
  const level = LEVEL[difficulty];
  const sectionCount = level.ordinal + 1;
  const title = `${level.label} Incident Response Playbook`;
  const audience = `${level.label.toLowerCase()} incident coordinators`;
  const criticalPhrase = `Escalate ${difficulty} incidents within 15 minutes.`;
  const checklist = "Owner, evidence, and next review date are present.";
  const oracle: DocxIr = {
    kind: "docx",
    title,
    audience,
    sections: Array.from({ length: sectionCount }, (_, index) => ({
      id: `section-${index + 1}`,
      heading: index === 0 ? "Immediate response" : `Response stage ${index + 1}`,
      blocks:
        index === 0
          ? [{ type: "paragraph", text: `${criticalPhrase} Record the decision owner.` }]
          : [{ type: "bullets", items: [`Complete stage ${index + 1}`, "Capture evidence"] }],
    })),
    reviewChecklist: [checklist],
  };
  const baseline = clone(oracle);
  baseline.audience = "all employees";
  baseline.sections.pop();
  (baseline.sections[0]!.blocks[0] as { type: "paragraph"; text: string }).text = "Respond promptly.";
  baseline.reviewChecklist = [];
  const requirements: ArtifactOracleRequirement[] = [
    { id: "document-title", path: "/title", operator: "equals", expected: title },
    { id: "document-audience", path: "/audience", operator: "equals", expected: audience },
    { id: "section-coverage", path: "/sections", operator: "min_items", expected: sectionCount },
    { id: "section-identities", path: "/sections", operator: "unique_by", key: "id" },
    { id: "response-heading", path: "/sections/0/heading", operator: "equals", expected: "Immediate response" },
    { id: "escalation-instruction", path: "/sections/0/blocks/0/text", operator: "string_includes", expected: criticalPhrase },
    { id: "review-check", path: "/reviewChecklist", operator: "contains", expected: checklist },
  ];
  const wrongTitle = clone(oracle);
  wrongTitle.title = "Incident Notes";
  const wrongAudience = clone(oracle);
  wrongAudience.audience = "general readers";
  const missingSection = clone(oracle);
  missingSection.sections.pop();
  const missingInstruction = clone(oracle);
  (missingInstruction.sections[0]!.blocks[0] as { type: "paragraph"; text: string }).text = "Record the decision owner.";
  const missingReview = clone(oracle);
  missingReview.reviewChecklist = [];
  return {
    objective: `Draft the semantic IR for a ${difficulty} incident-response playbook.`,
    publicInstructions: [
      `Use the title “${title}” for ${audience}.`,
      `Provide at least ${sectionCount} sections, beginning with “Immediate response”.`,
      `The opening paragraph must say: “${criticalPhrase}”`,
      `Include the review check: “${checklist}”`,
      "Return document IR only; DOCX pagination and rendering are separate gates.",
    ],
    oracle,
    baseline,
    requirements,
    baselineExpectedFailureRequirementIds: ["document-audience", "section-coverage", "escalation-instruction", "review-check"],
    mutationDrafts: [
      { id: "wrong-document-title", description: "Uses a generic document title.", artifact: wrongTitle },
      { id: "wrong-document-audience", description: "Targets the wrong readers.", artifact: wrongAudience },
      { id: "missing-document-section", description: "Omits a required section.", artifact: missingSection },
      { id: "missing-escalation", description: "Drops the timed escalation instruction.", artifact: missingInstruction },
      { id: "missing-review-check", description: "Drops the review checklist requirement.", artifact: missingReview },
    ],
  };
}

function pptxBlueprint(difficulty: ArtifactDifficulty): Blueprint {
  const level = LEVEL[difficulty];
  const slideCount = level.ordinal + 2;
  const title = `${level.label} Service Review`;
  const theme = `${difficulty}-clarity`;
  const firstPurpose = "Frame the decision required from the audience.";
  const callToAction = `Approve the ${difficulty} service experiment.`;
  const narrativeItem = "Problem → evidence → decision → next action";
  const oracle: PptxIr = {
    kind: "pptx",
    title,
    theme,
    slides: Array.from({ length: slideCount }, (_, index) => ({
      id: `slide-${index + 1}`,
      title: index === 0 ? "Decision required" : `Evidence ${index}`,
      purpose: index === 0 ? firstPurpose : `Support decision point ${index}.`,
      body:
        index === 1
          ? { type: "metric" as const, label: "Activation", value: `${70 + index}%`, context: "Current cohort" }
          : { type: "bullets" as const, items: [`Point ${index + 1}`, "Named owner"] },
      speakerNotes: index === 0 ? `Ask directly: ${callToAction}` : `Explain evidence ${index}.`,
    })),
    narrative: [narrativeItem],
  };
  const baseline = clone(oracle);
  baseline.theme = "default";
  baseline.slides.pop();
  baseline.slides[0]!.speakerNotes = "Discuss next steps.";
  baseline.narrative = [];
  const requirements: ArtifactOracleRequirement[] = [
    { id: "presentation-title", path: "/title", operator: "equals", expected: title },
    { id: "presentation-theme", path: "/theme", operator: "equals", expected: theme },
    { id: "slide-coverage", path: "/slides", operator: "min_items", expected: slideCount },
    { id: "slide-identities", path: "/slides", operator: "unique_by", key: "id" },
    { id: "decision-purpose", path: "/slides/0/purpose", operator: "equals", expected: firstPurpose },
    { id: "call-to-action", path: "/slides/0/speakerNotes", operator: "string_includes", expected: callToAction },
    { id: "narrative-arc", path: "/narrative", operator: "contains", expected: narrativeItem },
  ];
  const wrongTitle = clone(oracle);
  wrongTitle.title = "Service Update";
  const wrongTheme = clone(oracle);
  wrongTheme.theme = "default";
  const missingSlide = clone(oracle);
  missingSlide.slides.pop();
  const missingCall = clone(oracle);
  missingCall.slides[0]!.speakerNotes = "Discuss the evidence.";
  const missingNarrative = clone(oracle);
  missingNarrative.narrative = [];
  return {
    objective: `Create the semantic IR for a ${difficulty} service decision presentation.`,
    publicInstructions: [
      `Use the title “${title}”, theme “${theme}”, and at least ${slideCount} slides.`,
      `The first slide must serve this purpose: “${firstPurpose}”`,
      `Its speaker notes must include: “${callToAction}”`,
      `Declare the narrative arc “${narrativeItem}”.`,
      "Return presentation IR only; PPTX rendering and visual quality are separate gates.",
    ],
    oracle,
    baseline,
    requirements,
    baselineExpectedFailureRequirementIds: ["presentation-theme", "slide-coverage", "call-to-action", "narrative-arc"],
    mutationDrafts: [
      { id: "wrong-presentation-title", description: "Uses the wrong presentation title.", artifact: wrongTitle },
      { id: "wrong-presentation-theme", description: "Uses a generic theme.", artifact: wrongTheme },
      { id: "missing-presentation-slide", description: "Omits one required slide.", artifact: missingSlide },
      { id: "missing-call-to-action", description: "Drops the approval call to action.", artifact: missingCall },
      { id: "missing-narrative", description: "Drops the declared narrative arc.", artifact: missingNarrative },
    ],
  };
}

function blueprint(family: ArtifactFamily, difficulty: ArtifactDifficulty): Blueprint {
  if (family === "product_package") return productBlueprint(difficulty);
  if (family === "research") return researchBlueprint(difficulty);
  if (family === "xlsx") return xlsxBlueprint(difficulty);
  if (family === "docx") return docxBlueprint(difficulty);
  return pptxBlueprint(difficulty);
}

function selectMutations(
  seed: number,
  taskId: string,
  family: ArtifactFamily,
  drafts: readonly MutationDraft[],
): ArtifactMutation[] {
  return drafts
    .map((draft) => ({
      ...draft,
      selectionHash: canonicalArtifactSha256(`${seed}:${taskId}:${draft.id}`),
    }))
    .sort((left, right) => left.selectionHash.localeCompare(right.selectionHash))
    .slice(0, 3)
    .map(({ artifact, ...draft }) => {
      const wrapped = candidate(taskId, artifact);
      if (wrapped.artifact.kind !== family) throw new Error("Mutation family changed.");
      return {
        ...draft,
        candidate: wrapped,
        candidateHash: canonicalArtifactSha256(wrapped),
      };
    });
}

function hashInput(
  task: Omit<ArtifactEvaluationTask, "taskHash"> | ArtifactEvaluationTask,
): Omit<ArtifactEvaluationTask, "taskHash"> {
  const { taskHash: _ignored, ...input } = task as ArtifactEvaluationTask;
  return input;
}

export function artifactEvaluationTaskHash(
  task: Omit<ArtifactEvaluationTask, "taskHash"> | ArtifactEvaluationTask,
): string {
  return canonicalArtifactSha256(hashInput(task));
}

export function artifactEvaluationSuiteHash(
  tasks: readonly ArtifactEvaluationTask[],
): string {
  return canonicalArtifactSha256(
    [...tasks]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((task) => ({ id: task.id, taskHash: artifactEvaluationTaskHash(task) })),
  );
}

function assertFixtureIntegrity(task: ArtifactEvaluationTask): void {
  const oracle = evaluateArtifactOracle(task.oracleCandidate.artifact, task.oracleRequirements);
  if (!oracle.passed) throw new Error(`Oracle candidate fails '${task.id}'.`);
  const baseline = evaluateArtifactOracle(task.baselineCandidate.artifact, task.oracleRequirements);
  if (
    canonicalArtifactSha256(baseline.failedRequirementIds) !==
    canonicalArtifactSha256(task.baselineExpectedFailureRequirementIds)
  ) {
    throw new Error(`Baseline failure declaration differs for '${task.id}'.`);
  }
  for (const mutation of task.mutations) {
    const result = evaluateArtifactOracle(mutation.candidate.artifact, task.oracleRequirements);
    if (result.passed) throw new Error(`Mutation '${task.id}:${mutation.id}' survived.`);
  }
}

export function generateReferenceArtifactSuite(
  seed = DEFAULT_ARTIFACT_SUITE_SEED,
): ArtifactEvaluationTask[] {
  if (!Number.isSafeInteger(seed)) throw new TypeError("Artifact suite seed must be a safe integer.");
  const tasks: ArtifactEvaluationTask[] = [];
  for (const family of FAMILIES) {
    for (const difficulty of DIFFICULTIES) {
      const id = `${family.replaceAll("_", "-")}-${difficulty}-001`;
      const source = blueprint(family, difficulty);
      const oracleCandidate = candidate(id, source.oracle);
      const baselineCandidate = candidate(id, source.baseline);
      const withoutHash: Omit<ArtifactEvaluationTask, "taskHash"> = {
        apiVersion: WORKFLOW_ARTIFACT_SUITE_API_VERSION,
        id,
        family,
        difficulty,
        objective: source.objective,
        publicInstructions: clone(source.publicInstructions),
        oracleRequirements: clone(source.requirements),
        oracleCandidate,
        baselineCandidate,
        baselineExpectedFailureRequirementIds: clone(
          source.baselineExpectedFailureRequirementIds,
        ),
        mutations: selectMutations(seed, id, family, source.mutationDrafts),
      };
      const task = { ...withoutHash, taskHash: artifactEvaluationTaskHash(withoutHash) };
      assertFixtureIntegrity(task);
      tasks.push(task);
    }
  }
  return tasks;
}

export function projectPublicArtifactTask(
  task: ArtifactEvaluationTask,
): PublicArtifactEvaluationTask {
  return {
    apiVersion: WORKFLOW_ARTIFACT_SUITE_API_VERSION,
    id: task.id,
    family: task.family,
    difficulty: task.difficulty,
    objective: task.objective,
    publicInstructions: clone(task.publicInstructions),
    outputContract: {
      apiVersion: ARTIFACT_CANDIDATE_API_VERSION,
      taskId: task.id,
      artifactKind: task.family,
      format: "single-json-object",
      maximumBytes: 262144,
      semanticGateOnly: true,
    },
  };
}

export function projectSealedArtifactTask(
  task: ArtifactEvaluationTask,
): SealedArtifactEvaluationTask {
  return {
    apiVersion: WORKFLOW_ARTIFACT_SUITE_API_VERSION,
    publicTask: projectPublicArtifactTask(task),
    oracleRequirements: clone(task.oracleRequirements),
    oracleCandidate: clone(task.oracleCandidate),
    baselineCandidate: clone(task.baselineCandidate),
    baselineExpectedFailureRequirementIds: clone(
      task.baselineExpectedFailureRequirementIds,
    ),
    mutations: clone(task.mutations),
    taskHash: task.taskHash,
  };
}
