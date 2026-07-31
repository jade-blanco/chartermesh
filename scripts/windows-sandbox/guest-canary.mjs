import { spawn } from "node:child_process";
import {
  readFile,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

const inputRoot = "C:\\CharterMesh\\Input";
const outputRoot = "C:\\CharterMesh\\Output";
const runtimeNode = "C:\\CharterMesh\\Runtime\\node.exe";
const candidatePath = join(inputRoot, "canary-candidate.mjs");
const manifest = JSON.parse(
  await readFile(join(inputRoot, "canary-manifest.json"), "utf8"),
);
const maxOutputBytes = 65_536;

function runCandidate(arguments_, timeoutMs) {
  const startedAt = performance.now();
  return new Promise((resolve) => {
    const child = spawn(
      runtimeNode,
      [
        "--permission",
        `--allow-fs-read=${inputRoot}`,
        candidatePath,
        ...arguments_,
      ],
      {
        cwd: inputRoot,
        windowsHide: true,
        env: {
          SystemRoot: "C:\\Windows",
          TEMP: "C:\\Windows\\Temp",
          TMP: "C:\\Windows\\Temp",
          CHARTERMESH_SANDBOX_CANARY: "1",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    let outputLimitExceeded = false;
    let timedOut = false;
    let settled = false;

    const append = (target, chunk) => {
      const remaining = maxOutputBytes - outputBytes;
      if (remaining <= 0) {
        outputLimitExceeded = true;
        child.kill();
        return;
      }
      const bounded =
        chunk.byteLength <= remaining
          ? chunk
          : chunk.subarray(0, remaining);
      target.push(bounded);
      outputBytes += bounded.byteLength;
      if (bounded.byteLength !== chunk.byteLength) {
        outputLimitExceeded = true;
        child.kill();
      }
    };
    child.stdout.on("data", (chunk) => append(stdout, chunk));
    child.stderr.on("data", (chunk) => append(stderr, chunk));

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({
        ...result,
        timedOut,
        outputLimitExceeded,
        durationMs: Math.round(performance.now() - startedAt),
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    };
    child.on("error", (error) =>
      finish({
        exitCode: null,
        signal: null,
        launchError: error.message,
      }),
    );
    child.on("close", (exitCode, signal) =>
      finish({ exitCode, signal }),
    );
  });
}

const issues = [];
let candidateEvidence;
const timeoutMs = Math.max(
  250,
  Math.min(Number(manifest.timeoutMs) || 1_000, 5_000),
);

try {
  const probe = await runCandidate(
    [
      "probe",
      manifest.hostSentinelPath,
      join(outputRoot, "candidate-write-denial.txt"),
    ],
    10_000,
  );
  if (
    probe.timedOut ||
    probe.outputLimitExceeded ||
    probe.exitCode !== 0
  ) {
    issues.push("CANARY_CANDIDATE_PROBE_FAILED");
  } else {
    try {
      candidateEvidence = JSON.parse(probe.stdout);
    } catch {
      issues.push("CANARY_CANDIDATE_OUTPUT_INVALID");
    }
  }

  const hang = await runCandidate(["hang"], timeoutMs);
  if (!hang.timedOut) {
    issues.push("CANARY_TIMEOUT_NOT_ENFORCED");
  }

  const unexpectedOutputRelativePath =
    "unexpected-output-canary.txt";
  await writeFile(
    join(outputRoot, unexpectedOutputRelativePath),
    "This file must be rejected by the host output allowlist.\n",
    "utf8",
  );

  const evidence = {
    networkDenied:
      candidateEvidence?.evidence?.networkDenied === true,
    hostReadDenied:
      candidateEvidence?.evidence?.hostReadDenied === true,
    hostWriteDenied:
      candidateEvidence?.evidence?.hostWriteDenied === true,
    childEscapeDenied:
      candidateEvidence?.evidence?.childEscapeDenied === true,
    timeoutEnforced: hang.timedOut === true,
    outputAllowlistCanaryCreated: true,
  };
  for (const [name, passed] of Object.entries(evidence)) {
    if (!passed) issues.push(`CANARY_${name.toUpperCase()}_FAILED`);
  }

  await writeFile(
    join(outputRoot, "canary-report.json"),
    `${JSON.stringify({
      apiVersion:
        "chartermesh.dev/windows-sandbox-canary-report/v1alpha1",
      evidence,
      unexpectedOutputRelativePath,
      timeoutObservation: {
        requestedMs: timeoutMs,
        durationMs: hang.durationMs,
        exitCode: hang.exitCode,
        signal: hang.signal,
      },
      candidateObservations:
        candidateEvidence?.observations ?? null,
      issues,
    })}\n`,
    "utf8",
  );
} catch (error) {
  issues.push("CANARY_GUEST_RUNNER_FAILED");
  await writeFile(
    join(outputRoot, "canary-report.json"),
    `${JSON.stringify({
      apiVersion:
        "chartermesh.dev/windows-sandbox-canary-report/v1alpha1",
      evidence: {
        networkDenied: false,
        hostReadDenied: false,
        hostWriteDenied: false,
        childEscapeDenied: false,
        timeoutEnforced: false,
        outputAllowlistCanaryCreated: false,
      },
      issues,
      error:
        error instanceof Error
          ? error.message
          : "UNKNOWN_CANARY_ERROR",
    })}\n`,
    "utf8",
  );
} finally {
  await writeFile(
    join(outputRoot, "canary-complete.json"),
    `${JSON.stringify({
      apiVersion:
        "chartermesh.dev/windows-sandbox-canary-complete/v1alpha1",
      complete: true,
    })}\n`,
    "utf8",
  );
}
