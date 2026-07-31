import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

const stringify = JSON.stringify.bind(JSON);
const stdoutWrite = process.stdout.write.bind(process.stdout);
const objectCreate = Object.create.bind(Object);
const objectFreeze = Object.freeze.bind(Object);
const objectValues = Object.values.bind(Object);

function deepFreeze(value, seen = new Set()) {
  if (
    value === null ||
    (typeof value !== "object" && typeof value !== "function") ||
    seen.has(value)
  ) {
    return value;
  }
  seen.add(value);
  for (const child of objectValues(value)) deepFreeze(child, seen);
  return objectFreeze(value);
}

function emit(envelope) {
  stdoutWrite(`${stringify(envelope)}\n`);
}

const [modulePath] = process.argv.slice(2);
if (!modulePath) {
  process.stderr.write("candidate module path is required\n");
  process.exitCode = 2;
} else {
  let request;
  let requestSnapshot;
  try {
    request = JSON.parse(await readFile(0, "utf8"));
    requestSnapshot = structuredClone(request);
    deepFreeze(request);
    const module = await import(pathToFileURL(modulePath).href);
    if (typeof module.solve !== "function") {
      throw Object.assign(new Error("INVALID_EXPORT"), {
        code: "INVALID_EXPORT",
      });
    }
    const result = await module.solve(request);
    const envelope = objectCreate(null);
    envelope.kind = "return";
    envelope.value = result;
    envelope.inputMutated = !isDeepStrictEqual(
      request,
      requestSnapshot,
    );
    emit(envelope);
  } catch (error) {
    const code =
      error &&
      typeof error === "object" &&
      typeof error.code === "string"
        ? error.code
        : "UNHANDLED_ERROR";
    const envelope = objectCreate(null);
    envelope.kind = "throw";
    envelope.errorCode = code;
    envelope.inputMutated =
      requestSnapshot !== undefined &&
      !isDeepStrictEqual(request, requestSnapshot);
    emit(envelope);
  }
}
