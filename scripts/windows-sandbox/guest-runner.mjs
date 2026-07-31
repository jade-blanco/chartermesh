import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

const inputRoot = "C:\\CharterMesh\\Input";
const outputRoot = "C:\\CharterMesh\\Output";
const runtimeNode = "C:\\CharterMesh\\Runtime\\node.exe";
const manifest = JSON.parse(
  await readFile(join(inputRoot, "manifest.json"), "utf8"),
);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function runCase(job, item) {
  const request = await readFile(
    join(inputRoot, "requests", job.key, item.file),
    "utf8",
  );
  const child = spawn(
    runtimeNode,
    [
      "--permission",
      "--allow-child-process",
      `--allow-fs-read=${join(inputRoot, "candidate-executor.mjs")}`,
      `--allow-fs-read=${join(inputRoot, "candidate-worker.mjs")}`,
      join(inputRoot, "candidate-executor.mjs"),
      join(inputRoot, job.entrypoint),
    ],
    {
      cwd: inputRoot,
      windowsHide: true,
      env: {
        SystemRoot: "C:\\Windows",
        TEMP: "C:\\Windows\\Temp",
        TMP: "C:\\Windows\\Temp",
        CHARTERMESH_SANDBOX: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const stdout = [];
  const stderr = [];
  let outputBytes = 0;
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let outputLimitExceeded = false;
  const append = (target, chunk, stream) => {
    const remaining = manifest.maxOutputBytes - outputBytes;
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
    if (stream === "stdout") {
      stdoutBytes += bounded.byteLength;
    } else {
      stderrBytes += bounded.byteLength;
    }
    if (bounded.byteLength !== chunk.byteLength) {
      outputLimitExceeded = true;
      child.kill();
    }
  };
  child.stdout.on("data", (chunk) => {
    append(stdout, chunk, "stdout");
  });
  child.stderr.on("data", (chunk) => {
    append(stderr, chunk, "stderr");
  });
  child.stdin.end(request);
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, manifest.caseTimeoutMs);
  const result = await new Promise((resolve) => {
    child.on("error", (error) =>
      resolve({ exitCode: null, launchError: error.message }),
    );
    child.on("close", (exitCode, signal) =>
      resolve({ exitCode, signal }),
    );
  });
  clearTimeout(timeout);
  const stdoutText = Buffer.concat(stdout).toString("utf8");
  const stderrText = Buffer.concat(stderr).toString("utf8");
  return {
    jobId: job.id,
    id: item.id,
    ...result,
    timedOut,
    outputLimitExceeded,
    stdout: stdoutText,
    stdoutHash: sha256(stdoutText),
    stderrHash: sha256(stderrText),
    stdoutBytes,
    stderrBytes,
  };
}

let caseCount = 0;
for (const job of manifest.jobs) {
  await mkdir(join(outputRoot, "results", job.key), {
    recursive: true,
  });
  for (const item of job.cases) {
    const result = await runCase(job, item);
    await writeFile(
      join(outputRoot, "results", job.key, `${item.key}.json`),
      `${JSON.stringify(result)}\n`,
      "utf8",
    );
    caseCount += 1;
  }
}
await writeFile(
  join(outputRoot, "complete.json"),
  `${JSON.stringify({
    apiVersion: "chartermesh.dev/sandbox-complete/v1alpha1",
    jobCount: manifest.jobs.length,
    jobIds: manifest.jobs.map(({ id }) => id),
    caseCount,
  })}\n`,
  "utf8",
);
