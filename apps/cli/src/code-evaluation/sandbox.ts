import type { CodeCandidate } from "./candidate.ts";
import type {
  CodeEvaluationTask,
  CodeTestCase,
} from "./suite.ts";

export interface CodeSandboxManifest {
  id: string;
  isolation: "vm" | "container" | "simulated";
  network: "disabled" | "unknown";
  hostFilesystem: "mapped-allowlist" | "simulated" | "unknown";
  generatedCodeExecution: boolean;
}

export interface CodeSandboxProbe {
  ok: boolean;
  backendId: string;
  evidence: {
    networkDenied: boolean;
    hostReadDenied: boolean;
    hostWriteDenied: boolean;
    childEscapeDenied: boolean;
    timeoutEnforced: boolean;
    outputAllowlistEnforced: boolean;
  };
  issues: string[];
}

export interface CodeCaseResult {
  id: string;
  passed: boolean;
  exitCode: number | null;
  latencyMs: number;
  output?: unknown;
  outputHash?: string;
  errorCode?:
    | "SANDBOX_TIMEOUT"
    | "SANDBOX_LAUNCH_FAILED"
    | "PROGRAM_EXIT_NONZERO"
    | "PROGRAM_OUTPUT_LIMIT"
    | "PROGRAM_OUTPUT_INVALID"
    | "INPUT_MUTATED"
    | "EXPECTED_OUTPUT_MISMATCH"
    | "EXPECTED_ERROR_MISMATCH";
}

export interface CodeSandboxRunResult {
  jobId: string;
  taskId: string;
  passed: boolean;
  cases: CodeCaseResult[];
  changedPaths: string[];
  policyViolations: string[];
  survivorProcesses: number;
  outputBytes: number;
}

export interface CodeSandboxJob {
  id: string;
  task: Pick<
    CodeEvaluationTask,
    "id" | "baseFiles" | "editablePaths"
  >;
  candidate: CodeCandidate;
  cases: CodeTestCase[];
}

export interface CodeSandboxBackend {
  readonly manifest: CodeSandboxManifest;
  probe(): Promise<CodeSandboxProbe>;
  run(
    task: Pick<
      CodeEvaluationTask,
      "id" | "baseFiles" | "editablePaths"
    >,
    candidate: CodeCandidate,
    cases: CodeTestCase[],
    jobId?: string,
  ): Promise<CodeSandboxRunResult>;
  runBatch?(
    jobs: CodeSandboxJob[],
  ): Promise<CodeSandboxRunResult[]>;
}

export function sandboxProbePassed(
  probe: CodeSandboxProbe,
  manifest: CodeSandboxManifest,
): boolean {
  return (
    probe.backendId === manifest.id &&
    manifest.isolation === "vm" &&
    manifest.network === "disabled" &&
    manifest.hostFilesystem === "mapped-allowlist" &&
    manifest.generatedCodeExecution &&
    probe.ok &&
    probe.issues.length === 0 &&
    probe.evidence.networkDenied &&
    probe.evidence.hostReadDenied &&
    probe.evidence.hostWriteDenied &&
    probe.evidence.childEscapeDenied &&
    probe.evidence.timeoutEnforced &&
    probe.evidence.outputAllowlistEnforced
  );
}

export async function requireSafeSandbox(
  backend: CodeSandboxBackend,
): Promise<CodeSandboxProbe> {
  const probe = await backend.probe();
  if (!sandboxProbePassed(probe, backend.manifest)) {
    throw new Error(
      `CODE_SANDBOX_UNAVAILABLE: backend '${backend.manifest.id}' did not satisfy every VM isolation canary.`,
    );
  }
  return probe;
}

export function validateSandboxResults(
  jobs: CodeSandboxJob[],
  results: CodeSandboxRunResult[],
): CodeSandboxRunResult[] {
  if (results.length !== jobs.length) {
    throw new Error(
      `SANDBOX_RESULT_ID_MISMATCH: expected ${jobs.length} result(s), received ${results.length}.`,
    );
  }
  const byJobId = new Map<string, CodeSandboxRunResult>();
  for (const result of results) {
    if (!result.jobId || byJobId.has(result.jobId)) {
      throw new Error(
        `SANDBOX_RESULT_ID_MISMATCH: duplicate or empty job id '${result.jobId}'.`,
      );
    }
    byJobId.set(result.jobId, result);
  }
  return jobs.map((job) => {
    const result = byJobId.get(job.id);
    if (!result || result.taskId !== job.task.id) {
      throw new Error(
        `SANDBOX_RESULT_ID_MISMATCH: no result matched job '${job.id}' and task '${job.task.id}'.`,
      );
    }
    return result;
  });
}

export async function runSandboxJobs(
  backend: CodeSandboxBackend,
  jobs: CodeSandboxJob[],
): Promise<CodeSandboxRunResult[]> {
  const jobIds = new Set<string>();
  for (const job of jobs) {
    if (!job.id || jobIds.has(job.id)) {
      throw new Error(
        `SANDBOX_JOB_ID_INVALID: duplicate or empty job id '${job.id}'.`,
      );
    }
    jobIds.add(job.id);
  }
  if (backend.runBatch) {
    return validateSandboxResults(jobs, await backend.runBatch(jobs));
  }
  const results: CodeSandboxRunResult[] = [];
  for (const job of jobs) {
    results.push(
      await backend.run(
        job.task,
        job.candidate,
        job.cases,
        job.id,
      ),
    );
  }
  return validateSandboxResults(jobs, results);
}
