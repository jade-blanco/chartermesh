import { readdirSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { sha256 } from "../../../packages/orgspec/src/index.ts";
import type { OrganizationSpec } from "../../../packages/orgspec/src/types.ts";

export type ProposalProfile = "lean" | "balanced" | "controlled";

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
  rationale: string[];
  proposalHash: string;
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

export function organizationFor(
  profile: ProposalProfile,
  assessment: TargetAssessment,
): OrganizationSpec {
  const languageSummary =
    assessment.detectedLanguages.length > 0
      ? assessment.detectedLanguages.join(", ")
      : "general-purpose";
  const operator = {
    id: "operator",
    name: "Operator",
    class: "worker" as const,
    executionMode: "on_demand_ephemeral" as const,
    capabilities: ["artifact_generation"],
    requiredModelCapabilities: ["model.text.generate"],
    execution: { preferred: "local" },
    concurrency: 1,
    tools: {
      allow: [
        "workspace.list_files",
        "workspace.read_file",
        "workspace.write_file",
      ],
      approvalRequired: ["workspace.write_file"],
      workspaceRoots: ["."],
      maxIterations: profile === "lean" ? 3 : 5,
    },
  };
  const roles: OrganizationSpec["spec"]["roles"] =
    profile === "controlled"
      ? [
          operator,
          {
            id: "verifier",
            name: "Verifier",
            class: "reviewer",
            executionMode: "on_demand_ephemeral",
            capabilities: ["artifact_verification"],
            requiredModelCapabilities: ["model.text.generate"],
            execution: { preferred: "local" },
            concurrency: 1,
            tools: {
              allow: ["workspace.list_files", "workspace.read_file"],
              workspaceRoots: ["."],
              maxIterations: 4,
            },
          },
        ]
      : [operator];
  const stages: OrganizationSpec["spec"]["workflows"][number]["stages"] = [
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
      name: `CharterMesh team for ${assessment.projectName}`,
      revision: 1,
    },
    spec: {
      mission:
        `Safely produce reviewed artifacts for a ${languageSummary} project ` +
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
          name: "Reviewed Work",
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
): OrganizationProposal {
  const assessment = analyzeTarget(target);
  const organization = organizationFor(profile, assessment);
  const rationale = [
    `Selected the ${profile} operating profile.`,
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
    rationale,
  };
  return { ...body, proposalHash: sha256(body) };
}
