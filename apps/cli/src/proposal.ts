import { readdirSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { sha256 } from "../../../packages/orgspec/src/index.ts";
import type { OrganizationSpec } from "../../../packages/orgspec/src/types.ts";

export type ProposalProfile = "lean" | "balanced" | "controlled";

export type TeamTemplateId =
  | "general"
  | "software-product"
  | "research"
  | "content-production"
  | "data-analysis"
  | "operations";

type TeamRoleId = "coordinator" | "operator" | "verifier";

export interface TeamDesign {
  template: TeamTemplateId;
  source: "explicit" | "kickoff_default";
  entryRole: "operator";
  roles: Array<{
    id: TeamRoleId;
    name: string;
    class: "c_level" | "worker" | "reviewer";
    mission: string;
    capabilities: string[];
  }>;
  stages: Array<{
    id: "coordinate" | "produce" | "verify" | "review";
    name: string;
    type: "agent" | "approval";
    owner: TeamRoleId | "human";
    dependsOn: string[];
  }>;
  executionBoundary: "manual_handoffs_until_workflow_runtime_binding";
}

interface TeamTemplateDefinition {
  name: string;
  mission: string;
  workflowName: string;
  roles: Record<
    TeamRoleId,
    {
      name: string;
      mission: string;
      capabilities: readonly string[];
    }
  >;
  stageNames: {
    coordinate: string;
    produce: string;
    verify: string;
    review: string;
  };
}

/**
 * Sanitized, provider-neutral team patterns. These definitions deliberately
 * contain no project brief, user name, provider prompt, or provider identity.
 */
export const TEAM_DESIGNS = {
  general: {
    name: "General Delivery Team",
    mission: "Turn a bounded objective into a reviewable general-purpose outcome.",
    workflowName: "General Delivery Review",
    roles: {
      coordinator: {
        name: "Delivery Coordinator",
        mission: "Clarify the objective, boundaries, and handoff criteria.",
        capabilities: ["objective_coordination", "handoff_design"],
      },
      operator: {
        name: "Delivery Operator",
        mission: "Produce the requested outcome and its supporting evidence.",
        capabilities: ["artifact_generation", "general_delivery"],
      },
      verifier: {
        name: "Delivery Verifier",
        mission: "Check the outcome against its stated acceptance criteria.",
        capabilities: ["artifact_verification", "acceptance_review"],
      },
    },
    stageNames: {
      coordinate: "Coordinate Objective",
      produce: "Produce Outcome",
      verify: "Verify Outcome",
      review: "Human Review",
    },
  },
  "software-product": {
    name: "Software Product Team",
    mission: "Turn a bounded product objective into reviewable software evidence.",
    workflowName: "Software Product Delivery Review",
    roles: {
      coordinator: {
        name: "Product Coordinator",
        mission: "Define product scope, delivery boundaries, and acceptance intent.",
        capabilities: ["product_coordination", "software_scope_design"],
      },
      operator: {
        name: "Software Product Operator",
        mission: "Implement the bounded software change and collect evidence.",
        capabilities: ["artifact_generation", "software_product_delivery"],
      },
      verifier: {
        name: "Software Product Verifier",
        mission: "Check software evidence against product acceptance criteria.",
        capabilities: ["artifact_verification", "software_acceptance_review"],
      },
    },
    stageNames: {
      coordinate: "Coordinate Product Scope",
      produce: "Produce Software Outcome",
      verify: "Verify Software Outcome",
      review: "Human Product Review",
    },
  },
  research: {
    name: "Research Team",
    mission: "Turn a bounded question into a traceable and reviewable finding.",
    workflowName: "Research Finding Review",
    roles: {
      coordinator: {
        name: "Research Coordinator",
        mission: "Define the question, evidence boundaries, and review criteria.",
        capabilities: ["research_coordination", "evidence_scope_design"],
      },
      operator: {
        name: "Research Operator",
        mission: "Develop the finding and preserve traceable supporting evidence.",
        capabilities: ["artifact_generation", "research_synthesis"],
      },
      verifier: {
        name: "Research Verifier",
        mission: "Check evidence coverage, traceability, and stated limitations.",
        capabilities: ["artifact_verification", "evidence_review"],
      },
    },
    stageNames: {
      coordinate: "Coordinate Research Question",
      produce: "Produce Research Finding",
      verify: "Verify Research Finding",
      review: "Human Evidence Review",
    },
  },
  "content-production": {
    name: "Content Production Team",
    mission: "Turn a bounded communication objective into reviewable content.",
    workflowName: "Content Production Review",
    roles: {
      coordinator: {
        name: "Content Coordinator",
        mission: "Define audience, message boundaries, and editorial criteria.",
        capabilities: ["content_coordination", "editorial_scope_design"],
      },
      operator: {
        name: "Content Production Operator",
        mission: "Produce the content artifact and its editorial evidence.",
        capabilities: ["artifact_generation", "content_production"],
      },
      verifier: {
        name: "Content Production Verifier",
        mission: "Check content against the agreed audience and editorial criteria.",
        capabilities: ["artifact_verification", "editorial_review"],
      },
    },
    stageNames: {
      coordinate: "Coordinate Content Brief",
      produce: "Produce Content",
      verify: "Verify Content",
      review: "Human Editorial Review",
    },
  },
  "data-analysis": {
    name: "Data Analysis Team",
    mission: "Turn a bounded analytical question into a reviewable data finding.",
    workflowName: "Data Analysis Review",
    roles: {
      coordinator: {
        name: "Analysis Coordinator",
        mission: "Define the analytical question, data boundaries, and decision criteria.",
        capabilities: ["analysis_coordination", "data_scope_design"],
      },
      operator: {
        name: "Data Analysis Operator",
        mission: "Produce the analysis and preserve reproducible evidence.",
        capabilities: ["artifact_generation", "data_analysis"],
      },
      verifier: {
        name: "Data Analysis Verifier",
        mission: "Check analytical evidence, assumptions, and reproducibility.",
        capabilities: ["artifact_verification", "analysis_review"],
      },
    },
    stageNames: {
      coordinate: "Coordinate Analysis Question",
      produce: "Produce Data Finding",
      verify: "Verify Data Finding",
      review: "Human Analysis Review",
    },
  },
  operations: {
    name: "Operations Team",
    mission: "Turn a bounded operational objective into a controlled, reviewable outcome.",
    workflowName: "Operations Change Review",
    roles: {
      coordinator: {
        name: "Operations Coordinator",
        mission: "Define operational boundaries, handoffs, and control criteria.",
        capabilities: ["operations_coordination", "control_scope_design"],
      },
      operator: {
        name: "Operations Operator",
        mission: "Produce the operational artifact without exceeding approved boundaries.",
        capabilities: ["artifact_generation", "operations_delivery"],
      },
      verifier: {
        name: "Operations Verifier",
        mission: "Check control evidence and operational acceptance criteria.",
        capabilities: ["artifact_verification", "operations_control_review"],
      },
    },
    stageNames: {
      coordinate: "Coordinate Operational Scope",
      produce: "Produce Operational Outcome",
      verify: "Verify Operational Controls",
      review: "Human Operations Review",
    },
  },
} as const satisfies Readonly<Record<TeamTemplateId, TeamTemplateDefinition>>;

export interface TargetAssessment {
  apiVersion: "chartermesh.dev/target-assessment/v1alpha1";
  projectName: string;
  fileCount: number;
  detectedLanguages: string[];
  packageManagers: string[];
  ciSystems: string[];
  hasTests: boolean;
  riskSignals: string[];
  assessmentHash: string;
}

export interface OrganizationProposal {
  apiVersion: "chartermesh.dev/proposal/v1alpha1";
  profile: ProposalProfile;
  assessment: TargetAssessment;
  organization: OrganizationSpec;
  teamDesign?: TeamDesign;
  rationale: string[];
  proposalHash: string;
}

export interface ProposalOptions {
  webSearch?: boolean;
  teamTemplate?: TeamTemplateId;
  teamTemplateSource?: TeamDesign["source"];
}

const skippedDirectories = new Set([
  ".chartermesh",
  ".git",
  ".hg",
  ".next",
  ".pnpm-store",
  ".svn",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "target",
  "vendor",
]);

const languageByExtension: Record<string, string> = {
  ".c": "C",
  ".cc": "C++",
  ".cpp": "C++",
  ".cs": "C#",
  ".css": "CSS",
  ".go": "Go",
  ".html": "HTML",
  ".java": "Java",
  ".js": "JavaScript",
  ".jsx": "JavaScript",
  ".kt": "Kotlin",
  ".kts": "Kotlin",
  ".php": "PHP",
  ".py": "Python",
  ".rb": "Ruby",
  ".rs": "Rust",
  ".scala": "Scala",
  ".sql": "SQL",
  ".swift": "Swift",
  ".ts": "TypeScript",
  ".tsx": "TypeScript",
  ".vue": "Vue",
};

function stableStrings(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function profileBudgets(profile: ProposalProfile) {
  const operationalSafety = {
    unknownCostPolicy: "warn" as const,
    maxArtifactBytes: 1_048_576,
    maxWorkItemArtifactBytes: 10_485_760,
  };
  if (profile === "lean") {
    return {
      monthlyCostLimitUsd: 10,
      maxConcurrentRuns: 1,
      maxDailyModelStarts: 5,
      ...operationalSafety,
    };
  }
  if (profile === "controlled") {
    return {
      monthlyCostLimitUsd: 50,
      maxConcurrentRuns: 2,
      maxDailyModelStarts: 20,
      ...operationalSafety,
    };
  }
  return {
    monthlyCostLimitUsd: 25,
    maxConcurrentRuns: 2,
    maxDailyModelStarts: 20,
    ...operationalSafety,
  };
}

export function analyzeTarget(target: string): TargetAssessment {
  const languages = new Set<string>();
  const packageManagers = new Set<string>();
  const ciSystems = new Set<string>();
  const riskSignals = new Set<string>();
  let hasTests = false;
  let fileCount = 0;

  const visit = (directory: string, depth: number): void => {
    if (depth > 12 || fileCount >= 20_000) return;
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (fileCount >= 20_000) break;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!skippedDirectories.has(entry.name)) {
          visit(join(directory, entry.name), depth + 1);
        }
        continue;
      }
      if (!entry.isFile()) continue;
      fileCount += 1;
      const lower = entry.name.toLowerCase();
      const extension = extname(lower);
      const language = languageByExtension[extension];
      if (language) languages.add(language);
      if (
        /(?:^|[._-])(test|tests|spec|specs)(?:[._-]|$)/u.test(lower) ||
        ["pytest.ini", "vitest.config.ts", "jest.config.js"].includes(lower)
      ) {
        hasTests = true;
      }
      if (lower === "pnpm-lock.yaml") packageManagers.add("pnpm");
      if (lower === "package-lock.json") packageManagers.add("npm");
      if (lower === "yarn.lock") packageManagers.add("yarn");
      if (lower === "bun.lock" || lower === "bun.lockb") {
        packageManagers.add("bun");
      }
      if (lower === "poetry.lock") packageManagers.add("poetry");
      if (lower === "uv.lock") packageManagers.add("uv");
      if (lower === "pipfile.lock") packageManagers.add("pipenv");
      if (lower === "cargo.lock") packageManagers.add("cargo");
      if (lower === "go.sum") packageManagers.add("go");
      if (lower === ".gitlab-ci.yml") ciSystems.add("gitlab-actions");
      if (lower === "azure-pipelines.yml") ciSystems.add("azure-pipelines");
      if (lower === "dockerfile" || lower === "compose.yml") {
        riskSignals.add("container-runtime");
      }
      if (extension === ".tf") riskSignals.add("infrastructure-as-code");
      if (/deploy|release|production/u.test(lower)) {
        riskSignals.add("deployment-automation");
      }
      const normalized = directory.replaceAll("\\", "/").toLowerCase();
      if (normalized.endsWith("/.github/workflows")) {
        ciSystems.add("github-actions");
        if (extension === ".yml" || extension === ".yaml") {
          riskSignals.add("repository-automation");
        }
      }
    }
  };

  visit(target, 0);
  const body = {
    apiVersion: "chartermesh.dev/target-assessment/v1alpha1" as const,
    projectName: basename(target),
    fileCount,
    detectedLanguages: stableStrings(languages),
    packageManagers: stableStrings(packageManagers),
    ciSystems: stableStrings(ciSystems),
    hasTests,
    riskSignals: stableStrings(riskSignals),
  };
  return { ...body, assessmentHash: sha256(body) };
}

function roleIdsFor(profile: ProposalProfile): TeamRoleId[] {
  if (profile === "lean") return ["operator"];
  if (profile === "controlled") {
    return ["coordinator", "operator", "verifier"];
  }
  return ["coordinator", "operator"];
}

function teamDesignFor(
  profile: ProposalProfile,
  teamTemplate: TeamTemplateId,
  webSearch: boolean,
  source: TeamDesign["source"] = "explicit",
): TeamDesign {
  const template = TEAM_DESIGNS[teamTemplate];
  if (!template) {
    throw new Error(`Unknown team template '${String(teamTemplate)}'.`);
  }
  const roleClass: Record<TeamRoleId, TeamDesign["roles"][number]["class"]> = {
    coordinator: "c_level",
    operator: "worker",
    verifier: "reviewer",
  };
  const roles = roleIdsFor(profile).map((id) => ({
    id,
    name: template.roles[id].name,
    class: roleClass[id],
    mission: template.roles[id].mission,
    capabilities: [
      ...template.roles[id].capabilities,
      ...(webSearch ? ["web_research"] : []),
    ],
  }));
  const coordinateOwner: TeamRoleId =
    profile === "lean" ? "operator" : "coordinator";
  const stages: TeamDesign["stages"] = [
    {
      id: "coordinate",
      name: template.stageNames.coordinate,
      type: "agent",
      owner: coordinateOwner,
      dependsOn: [],
    },
    {
      id: "produce",
      name: template.stageNames.produce,
      type: "agent",
      owner: "operator",
      dependsOn: ["coordinate"],
    },
    ...(profile === "controlled"
      ? [
          {
            id: "verify" as const,
            name: template.stageNames.verify,
            type: "agent" as const,
            owner: "verifier" as const,
            dependsOn: ["produce"],
          },
        ]
      : []),
    {
      id: "review",
      name: template.stageNames.review,
      type: "approval",
      owner: "human",
      dependsOn: [profile === "controlled" ? "verify" : "produce"],
    },
  ];
  return {
    template: teamTemplate,
    source,
    entryRole: "operator",
    roles,
    stages,
    executionBoundary: "manual_handoffs_until_workflow_runtime_binding",
  };
}

export function organizationFor(
  profile: ProposalProfile,
  assessment: TargetAssessment,
  options: ProposalOptions = {},
): OrganizationSpec {
  const teamDesign = options.teamTemplate
    ? teamDesignFor(
        profile,
        options.teamTemplate,
        Boolean(options.webSearch),
        options.teamTemplateSource,
      )
    : undefined;
  const template = options.teamTemplate
    ? TEAM_DESIGNS[options.teamTemplate]
    : undefined;
  const languageSummary =
    assessment.detectedLanguages.length > 0
      ? assessment.detectedLanguages.join(", ")
      : "general-purpose";
  const operatorDesign = teamDesign?.roles.find(({ id }) => id === "operator");
  const operator = {
    id: "operator",
    name: operatorDesign?.name ?? "Operator",
    class: "worker" as const,
    executionMode: "on_demand_ephemeral" as const,
    capabilities:
      operatorDesign?.capabilities ??
      [
        "artifact_generation",
        ...(options.webSearch ? ["web_research"] : []),
      ],
    requiredModelCapabilities: ["model.text.generate"],
    execution: { preferred: "local" },
    concurrency: 1,
    tools: {
      allow: [
        "workspace.list_files",
        "workspace.read_file",
        "workspace.write_file",
        ...(options.webSearch ? ["web.search"] : []),
      ],
      approvalRequired: [
        "workspace.write_file",
        ...(options.webSearch ? ["web.search"] : []),
      ],
      workspaceRoots: ["."],
      maxIterations: profile === "lean" ? 3 : 5,
    },
  };
  const roles: OrganizationSpec["spec"]["roles"] = teamDesign
    ? teamDesign.roles.map(
        (role): OrganizationSpec["spec"]["roles"][number] =>
          role.id === "operator"
            ? operator
            : {
                id: role.id,
                name: role.name,
                class: role.class,
                executionMode: "on_demand_ephemeral",
                capabilities: role.capabilities,
                requiredModelCapabilities: ["model.text.generate"],
                execution: { preferred: "local" },
                concurrency: 1,
                tools: {
                  allow: [
                    "workspace.list_files",
                    "workspace.read_file",
                    ...(options.webSearch ? ["web.search"] : []),
                  ],
                  ...(options.webSearch
                    ? { approvalRequired: ["web.search"] }
                    : {}),
                  workspaceRoots: ["."],
                  maxIterations: 4,
                },
              },
      )
    : profile === "controlled"
      ? [
          operator,
          {
            id: "verifier",
            name: "Verifier",
            class: "reviewer",
            executionMode: "on_demand_ephemeral",
            capabilities: [
              "artifact_verification",
              ...(options.webSearch ? ["web_research"] : []),
            ],
            requiredModelCapabilities: ["model.text.generate"],
            execution: { preferred: "local" },
            concurrency: 1,
            tools: {
              allow: [
                "workspace.list_files",
                "workspace.read_file",
                ...(options.webSearch ? ["web.search"] : []),
              ],
              ...(options.webSearch
                ? { approvalRequired: ["web.search"] }
                : {}),
              workspaceRoots: ["."],
              maxIterations: 4,
            },
          },
        ]
      : [operator];
  const stages: OrganizationSpec["spec"]["workflows"][number]["stages"] =
    teamDesign
      ? teamDesign.stages.map((stage): OrganizationSpec["spec"]["workflows"][number]["stages"][number] => {
          if (stage.type === "approval") {
            return {
              id: stage.id,
              type: "approval",
              dependsOn: stage.dependsOn,
              acceptanceCriteria: [
                "A human approves the exact immutable artifact hash.",
              ],
            };
          }
          if (stage.owner === "human") {
            throw new Error(`Agent stage '${stage.id}' requires an agent role.`);
          }
          if (stage.id === "coordinate") {
            return {
              id: stage.id,
              type: "agent",
              role: stage.owner,
              dependsOn: stage.dependsOn,
              outputContract: "chartermesh.dev/coordination-brief/v1alpha1",
              acceptanceCriteria: [
                "A bounded coordination brief defines responsibilities, handoffs, and review points.",
              ],
            };
          }
          if (stage.id === "verify") {
            return {
              id: stage.id,
              type: "agent",
              role: stage.owner,
              dependsOn: stage.dependsOn,
              outputContract: "chartermesh.dev/verification/v1alpha1",
              acceptanceCriteria: [
                "The artifact is checked against its acceptance criteria.",
              ],
            };
          }
          return {
            id: stage.id,
            type: "agent",
            role: stage.owner,
            dependsOn: stage.dependsOn,
            outputContract: "chartermesh.dev/structured-artifact/v1alpha1",
            acceptanceCriteria: [
              "A structured, human-readable artifact is submitted for review.",
            ],
          };
        })
      : [
          {
            id: "produce",
            type: "agent",
            role: "operator",
            outputContract: "chartermesh.dev/structured-artifact/v1alpha1",
            acceptanceCriteria: [
              "A structured, human-readable artifact is submitted for review.",
            ],
          },
          ...(profile === "controlled"
            ? [
                {
                  id: "verify",
                  type: "agent" as const,
                  role: "verifier",
                  dependsOn: ["produce"],
                  outputContract: "chartermesh.dev/verification/v1alpha1",
                  acceptanceCriteria: [
                    "The artifact is checked against its acceptance criteria.",
                  ],
                },
              ]
            : []),
          {
            id: "review",
            type: "approval",
            dependsOn: [profile === "controlled" ? "verify" : "produce"],
            acceptanceCriteria: [
              "A human approves the exact immutable artifact hash.",
            ],
          },
        ];

  return {
    apiVersion: "chartermesh.dev/v1alpha1",
    kind: "Organization",
    metadata: {
      id: "local-team",
      name: template
        ? `${template.name} for ${assessment.projectName}`
        : `CharterMesh team for ${assessment.projectName}`,
      revision: 1,
    },
    spec: {
      mission: template
        ? template.mission
        : `Safely produce reviewed artifacts for a ${languageSummary} project ` +
          `using the ${profile} operating profile.`,
      operatingProfile: profile,
      budgets: profileBudgets(profile),
      modelEngines: [
        {
          id: "primary-model",
          adapter: "configured-at-runtime",
          transport: "embedded",
          enabled: true,
        },
      ],
      agentHosts: [],
      managedRunners: [
        {
          id: "local-runner",
          adapter: "builtin-managed-runner",
          modelEngineRef: "primary-model",
          executionHost: "local",
          enabled: true,
        },
      ],
      executionTargets: [
        {
          id: "local",
          kind: "managed_runner",
          runnerRef: "local-runner",
          enabled: true,
        },
      ],
      roles,
      workflows: [
        {
          id: "reviewed-work",
          name: template?.workflowName ?? "Reviewed Work",
          trigger: { type: "manual" },
          stages,
        },
      ],
      schedules: [],
      policies: {
        externalSideEffects: "user_approval",
        destructiveActions: "prohibited",
        providerFailover: "same_or_lower_permissions",
        organizationChanges: "user_approval",
        firstRunMode: "read_only",
      },
    },
  };
}

export function createProposal(
  target: string,
  profile: ProposalProfile,
  options: ProposalOptions = {},
): OrganizationProposal {
  const assessment = analyzeTarget(target);
  const organization = organizationFor(profile, assessment, options);
  const teamDesign = options.teamTemplate
    ? teamDesignFor(
        profile,
        options.teamTemplate,
        Boolean(options.webSearch),
        options.teamTemplateSource,
      )
    : undefined;
  const rationale = [
    `Selected the ${profile} operating profile.`,
    ...(teamDesign
      ? [
          `Applied the '${teamDesign.template}' sanitized team template from ${teamDesign.source}; it contains no user data or provider prompt.`,
        ]
      : []),
    options.webSearch
      ? "Enabled approval-gated web.search for the reviewed SearXNG endpoint."
      : "Kept external web search disabled by default.",
    `Detected ${assessment.fileCount} reviewable files without reading file contents.`,
    assessment.detectedLanguages.length > 0
      ? `Detected languages: ${assessment.detectedLanguages.join(", ")}.`
      : "No dominant implementation language was detected.",
    assessment.riskSignals.length > 0
      ? `Risk signals require explicit review: ${assessment.riskSignals.join(", ")}.`
      : "No deployment or infrastructure automation signal was detected.",
  ];
  const body = {
    apiVersion: "chartermesh.dev/proposal/v1alpha1" as const,
    profile,
    assessment,
    organization,
    ...(teamDesign ? { teamDesign } : {}),
    rationale,
  };
  return { ...body, proposalHash: sha256(body) };
}
