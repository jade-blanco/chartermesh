import { createHmac, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const MAX_WORKER_OUTPUT_BYTES = 90_000;
const WORKER_TIMEOUT_MS = 12_000;
const stringify = JSON.stringify.bind(JSON);
const parse = JSON.parse.bind(JSON);
const stdoutWrite = process.stdout.write.bind(process.stdout);
const bufferFrom = Buffer.from.bind(Buffer);
const bufferConcat = Buffer.concat.bind(Buffer);
const bufferToString = Buffer.prototype.toString;
const objectCreate = Object.create.bind(Object);
const objectKeys = Object.keys.bind(Object);
const workerPath = fileURLToPath(
  new URL("./candidate-worker.mjs", import.meta.url),
);

export function validateWorkerEnvelope(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value;
  const expectedKeys =
    record.kind === "return"
      ? ["inputMutated", "kind", "value"]
      : ["errorCode", "inputMutated", "kind"];
  if (
    !["return", "throw"].includes(String(record.kind)) ||
    !isDeepStrictEqual(objectKeys(record).sort(), expectedKeys) ||
    typeof record.inputMutated !== "boolean" ||
    (record.kind === "throw" &&
      (typeof record.errorCode !== "string" ||
        record.errorCode.length < 1 ||
        record.errorCode.length > 256 ||
        /[\u0000-\u001f\u007f]/u.test(record.errorCode)))
  ) {
    return null;
  }
  return record;
}

export function acceptWorkerResult(result) {
  if (
    !result ||
    typeof result !== "object" ||
    result.exitCode !== 0 ||
    result.timedOut !== false ||
    result.outputLimitExceeded !== false ||
    result.launchError !== undefined ||
    typeof result.stdout !== "string"
  ) {
    return null;
  }
  try {
    return validateWorkerEnvelope(parse(result.stdout));
  } catch {
    return null;
  }
}

function emit(envelope, sessionId, secret) {
  const normalized = objectCreate(null);
  normalized.kind = envelope.kind;
  if (envelope.kind === "return") {
    normalized.value = envelope.value;
  } else {
    normalized.errorCode = envelope.errorCode;
  }
  normalized.inputMutated = envelope.inputMutated;
  const payload = stringify(normalized);
  const encoded = bufferToString.call(
    bufferFrom(payload, "utf8"),
    "base64url",
  );
  const mac = createHmac("sha256", secret)
    .update(encoded)
    .digest("hex");
  stdoutWrite(
    `@@CHARTERMESH_RESULT_V1@@:${sessionId}:${encoded}:${mac}\n`,
  );
}

async function runWorker(modulePath, request) {
  const child = spawn(
    process.execPath,
    [
      "--permission",
      `--allow-fs-read=${workerPath}`,
      `--allow-fs-read=${dirname(modulePath)}`,
      workerPath,
      modulePath,
    ],
    {
      cwd: dirname(modulePath),
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
  let outputLimitExceeded = false;
  const append = (target, chunk) => {
    const remaining = MAX_WORKER_OUTPUT_BYTES - outputBytes;
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
  child.stdin.end(request);
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, WORKER_TIMEOUT_MS);
  const result = await new Promise((resolve) => {
    child.on("error", (error) =>
      resolve({ exitCode: null, launchError: error.message }),
    );
    child.on("close", (exitCode, signal) =>
      resolve({ exitCode, signal }),
    );
  });
  clearTimeout(timeout);
  return {
    ...result,
    timedOut,
    outputLimitExceeded,
    stdout: bufferToString.call(bufferConcat(stdout), "utf8"),
    stderr: bufferToString.call(bufferConcat(stderr), "utf8"),
  };
}

async function main() {
  const sessionId = randomBytes(16).toString("hex");
  const secret = randomBytes(32);
  const secretHex = bufferToString.call(secret, "hex");
  // This authenticates framing by this supervisor. It is not an OS-user
  // isolation boundary against another same-user host/guest process.
  stdoutWrite(
    `@@CHARTERMESH_HANDSHAKE_V1@@:${sessionId}:${secretHex}\n`,
  );
  const [modulePath] = process.argv.slice(2);
  if (!modulePath) {
    process.stderr.write("candidate module path is required\n");
    process.exitCode = 2;
    return;
  }
  const request = await readFile(0, "utf8");
  const result = await runWorker(modulePath, request);
  const envelope = acceptWorkerResult(result);
  if (!envelope) {
    process.stderr.write(
      `candidate worker failed: ${stringify({
        exitCode: result.exitCode,
        signal: result.signal,
        timedOut: result.timedOut,
        outputLimitExceeded: result.outputLimitExceeded,
        launchError: result.launchError,
      })}\n`,
    );
    process.exitCode = 3;
    return;
  }
  emit(envelope, sessionId, secret);
}

if (import.meta.main) {
  await main();
}
