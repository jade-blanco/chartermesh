import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  readFile,
  readdir,
  stat,
} from "node:fs/promises";
import {
  arch,
  platform,
  release,
  version,
} from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const GIT_COMMIT_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const PACKAGE_VERSION_PATTERN =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const NODE_VERSION_PATTERN = /^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u;

export const CODE_EVALUATION_GUEST_BUNDLE_PATHS = [
  "scripts/windows-sandbox/canary-candidate.mjs",
  "scripts/windows-sandbox/candidate-executor.mjs",
  "scripts/windows-sandbox/candidate-worker.mjs",
  "scripts/windows-sandbox/guest-canary.mjs",
  "scripts/windows-sandbox/guest-runner.mjs",
] as const;

export interface CodeEvaluationProvenance {
  schemaVersion: "chartermesh.dev/code-evaluation-provenance/v1alpha1";
  charterMesh: {
    packageVersion: string;
  };
  git: {
    commit: string | null;
    dirty: boolean | null;
  };
  node: {
    /** Node process version running the evaluation harness. */
    version: string;
    /** Exact executable selected for staging into the sandbox VM. */
    runtimeExecutableSha256: string;
  };
  os: {
    platform: string;
    arch: string;
    version: string;
    build: string;
  };
  sandboxGuestBundle: {
    format: "canonical-json-sha256-v1";
    files: Array<{
      path: string;
      sha256: string;
    }>;
    manifestSha256: string;
  };
}

export interface CollectCodeEvaluationProvenanceOptions {
  packageJson: string | URL;
  repositoryDirectory: string | URL;
  runtimeExecutable: string | URL;
  guestBundleDirectory: string | URL;
}

function filesystemPath(value: string | URL): string {
  return value instanceof URL ? fileURLToPath(value) : value;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .filter((key) => object[key] !== undefined)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJson(object[key])}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function codeEvaluationGuestManifestSha256(
  files: CodeEvaluationProvenance["sandboxGuestBundle"]["files"],
): string {
  return sha256(canonicalJson(files));
}

async function sha256File(path: string): Promise<string> {
  const info = await stat(path);
  if (!info.isFile()) {
    throw new Error(`'${basename(path)}' is not a regular file.`);
  }
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: string[],
): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function safeSystemString(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 512 &&
    !/[\0\r\n]/u.test(value)
  );
}

export function validateCodeEvaluationProvenance(
  value: unknown,
): asserts value is CodeEvaluationProvenance {
  const invalid = (): never => {
    throw new Error(
      "CODE_EVALUATION_PROVENANCE_INVALID: provenance does not satisfy the strict v1alpha1 contract.",
    );
  };
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "schemaVersion",
      "charterMesh",
      "git",
      "node",
      "os",
      "sandboxGuestBundle",
    ]) ||
    value.schemaVersion !==
      "chartermesh.dev/code-evaluation-provenance/v1alpha1" ||
    !isRecord(value.charterMesh) ||
    !hasExactKeys(value.charterMesh, ["packageVersion"]) ||
    typeof value.charterMesh.packageVersion !== "string" ||
    !PACKAGE_VERSION_PATTERN.test(value.charterMesh.packageVersion) ||
    !isRecord(value.git) ||
    !hasExactKeys(value.git, ["commit", "dirty"]) ||
    !(
      value.git.commit === null ||
      (typeof value.git.commit === "string" &&
        GIT_COMMIT_PATTERN.test(value.git.commit))
    ) ||
    !(
      value.git.dirty === null ||
      typeof value.git.dirty === "boolean"
    ) ||
    !isRecord(value.node) ||
    !hasExactKeys(value.node, [
      "version",
      "runtimeExecutableSha256",
    ]) ||
    typeof value.node.version !== "string" ||
    !NODE_VERSION_PATTERN.test(value.node.version) ||
    typeof value.node.runtimeExecutableSha256 !== "string" ||
    !SHA256_PATTERN.test(value.node.runtimeExecutableSha256) ||
    !isRecord(value.os) ||
    !hasExactKeys(value.os, [
      "platform",
      "arch",
      "version",
      "build",
    ]) ||
    !safeSystemString(value.os.platform) ||
    !safeSystemString(value.os.arch) ||
    !safeSystemString(value.os.version) ||
    !safeSystemString(value.os.build) ||
    !isRecord(value.sandboxGuestBundle) ||
    !hasExactKeys(value.sandboxGuestBundle, [
      "format",
      "files",
      "manifestSha256",
    ]) ||
    value.sandboxGuestBundle.format !==
      "canonical-json-sha256-v1" ||
    !Array.isArray(value.sandboxGuestBundle.files) ||
    typeof value.sandboxGuestBundle.manifestSha256 !== "string" ||
    !SHA256_PATTERN.test(value.sandboxGuestBundle.manifestSha256)
  ) {
    invalid();
  }
  const files = value.sandboxGuestBundle.files;
  if (
    files.length !== CODE_EVALUATION_GUEST_BUNDLE_PATHS.length ||
    files.some(
      (file) =>
        !isRecord(file) ||
        !hasExactKeys(file, ["path", "sha256"]) ||
        typeof file.path !== "string" ||
        typeof file.sha256 !== "string" ||
        !SHA256_PATTERN.test(file.sha256),
    )
  ) {
    invalid();
  }
  const expectedPaths = [...CODE_EVALUATION_GUEST_BUNDLE_PATHS];
  const actualPaths = files.map(({ path }) => path);
  if (
    actualPaths.some((path, index) => path !== expectedPaths[index]) ||
    value.sandboxGuestBundle.manifestSha256 !==
      codeEvaluationGuestManifestSha256(
        files as CodeEvaluationProvenance["sandboxGuestBundle"]["files"],
      )
  ) {
    invalid();
  }
}

async function gitOutput(
  repositoryDirectory: string,
  args: string[],
): Promise<string | null> {
  try {
    const { stdout } = await execFile("git", args, {
      cwd: repositoryDirectory,
      encoding: "utf8",
      timeout: 5_000,
      windowsHide: true,
      maxBuffer: 8_388_608,
    });
    return String(stdout).trim();
  } catch {
    return null;
  }
}

export async function collectCodeEvaluationProvenance(
  options: CollectCodeEvaluationProvenanceOptions,
): Promise<CodeEvaluationProvenance> {
  const packageJsonPath = filesystemPath(options.packageJson);
  const repositoryDirectory = filesystemPath(
    options.repositoryDirectory,
  );
  const runtimeExecutable = filesystemPath(options.runtimeExecutable);
  const guestBundleDirectory = filesystemPath(
    options.guestBundleDirectory,
  );

  let packageVersion: string;
  try {
    const packageValue = JSON.parse(
      await readFile(packageJsonPath, "utf8"),
    ) as unknown;
    if (
      !isRecord(packageValue) ||
      typeof packageValue.version !== "string" ||
      !PACKAGE_VERSION_PATTERN.test(packageValue.version)
    ) {
      throw new Error("package version is invalid");
    }
    packageVersion = packageValue.version;
  } catch (error) {
    throw new Error(
      `CODE_EVALUATION_PACKAGE_VERSION_UNAVAILABLE: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  let runtimeExecutableSha256: string;
  try {
    runtimeExecutableSha256 = await sha256File(runtimeExecutable);
  } catch (error) {
    throw new Error(
      `CODE_EVALUATION_RUNTIME_HASH_UNAVAILABLE: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  let guestFiles: CodeEvaluationProvenance["sandboxGuestBundle"]["files"];
  try {
    const discovered = (await readdir(guestBundleDirectory))
      .filter((name) => name.endsWith(".mjs"))
      .sort()
      .map((name) => `scripts/windows-sandbox/${name}`);
    if (
      discovered.length !== CODE_EVALUATION_GUEST_BUNDLE_PATHS.length ||
      discovered.some(
        (path, index) =>
          path !== CODE_EVALUATION_GUEST_BUNDLE_PATHS[index],
      )
    ) {
      throw new Error("guest script set does not match the sealed bundle");
    }
    guestFiles = [];
    for (const relativePath of discovered) {
      guestFiles.push({
        path: relativePath,
        sha256: await sha256File(
          join(guestBundleDirectory, basename(relativePath)),
        ),
      });
    }
  } catch (error) {
    throw new Error(
      `CODE_EVALUATION_GUEST_BUNDLE_UNATTESTED: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const commit = (
    await gitOutput(repositoryDirectory, [
      "rev-parse",
      "--verify",
      "HEAD",
    ])
  )?.toLowerCase() ?? null;
  const status = await gitOutput(repositoryDirectory, [
    "status",
    "--porcelain=v1",
    "--untracked-files=normal",
  ]);
  const provenance: CodeEvaluationProvenance = {
    schemaVersion:
      "chartermesh.dev/code-evaluation-provenance/v1alpha1",
    charterMesh: { packageVersion },
    git: {
      commit:
        commit && GIT_COMMIT_PATTERN.test(commit) ? commit : null,
      dirty: status === null ? null : status.length > 0,
    },
    node: {
      version: process.version,
      runtimeExecutableSha256,
    },
    os: {
      platform: platform(),
      arch: arch(),
      version: version(),
      build: release(),
    },
    sandboxGuestBundle: {
      format: "canonical-json-sha256-v1",
      files: guestFiles,
      manifestSha256:
        codeEvaluationGuestManifestSha256(guestFiles),
    },
  };
  validateCodeEvaluationProvenance(provenance);
  return provenance;
}
