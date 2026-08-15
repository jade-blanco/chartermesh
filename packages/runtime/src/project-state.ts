import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

export interface ProjectStatePaths {
  projectRoot: string;
  root: string;
  database: string;
  artifacts: string;
  installation: string;
  organization: string;
  proposal: string;
  runtime: string;
  exports: string;
  backups: string;
  engineWork: string;
}

export function assertNoLinkedPathComponents(path: string): void {
  const ancestors: string[] = [];
  let cursor = resolve(path);
  while (true) {
    ancestors.push(cursor);
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  for (const component of ancestors.reverse()) {
    if (!existsSync(component)) break;
    const metadata = lstatSync(component);
    if (metadata.isSymbolicLink()) {
      throw new Error(
        `PROJECT_STATE_LINK_REJECTED: linked or reparse-point component '${component}' is not allowed.`,
      );
    }
  }
}

export function resolveProjectStatePaths(
  target: string,
  options: { requireInitialized?: boolean } = {},
): ProjectStatePaths {
  const projectRoot = resolve(target);
  const root = join(projectRoot, ".chartermesh");
  assertNoLinkedPathComponents(root);
  if (existsSync(projectRoot) && !lstatSync(projectRoot).isDirectory()) {
    throw new Error("PROJECT_ROOT_INVALID: target must be a directory.");
  }
  const paths: ProjectStatePaths = {
    projectRoot,
    root,
    database: join(root, "state.db"),
    artifacts: join(root, "artifacts"),
    installation: join(root, "installation.json"),
    organization: join(root, "organization.json"),
    proposal: join(root, "proposal.json"),
    runtime: join(root, "runtime.json"),
    exports: join(root, "exports"),
    backups: join(root, "backups"),
    engineWork: join(root, "engine-work"),
  };
  for (const path of Object.values(paths)) {
    if (path === projectRoot || path === root || !existsSync(path)) continue;
    if (lstatSync(path).isSymbolicLink()) {
      throw new Error(
        `PROJECT_STATE_LINK_REJECTED: linked or reparse-point state path '${path}' is not allowed.`,
      );
    }
  }
  for (const sidecar of [`${paths.database}-wal`, `${paths.database}-shm`]) {
    if (existsSync(sidecar) && lstatSync(sidecar).isSymbolicLink()) {
      throw new Error(
        `PROJECT_STATE_LINK_REJECTED: linked or reparse-point state path '${sidecar}' is not allowed.`,
      );
    }
  }
  if (
    options.requireInitialized &&
    (!existsSync(paths.root) ||
      !existsSync(paths.runtime) ||
      !existsSync(paths.organization) ||
      !existsSync(paths.database))
  ) {
    throw new Error(
      "PROJECT_NOT_INITIALIZED: run CharterMesh kickoff or bootstrap first.",
    );
  }
  return paths;
}

export function readBoundedRegularText(
  path: string,
  options: { maxBytes?: number; allowEmpty?: boolean } = {},
): string {
  const maximum = options.maxBytes ?? 2 * 1024 * 1024;
  assertNoLinkedPathComponents(path);
  if (!existsSync(path)) {
    throw new Error(`PROJECT_STATE_FILE_MISSING: '${path}' is unavailable.`);
  }
  const before = lstatSync(path);
  if (
    !before.isFile() ||
    (!options.allowEmpty && before.size === 0) ||
    before.size > maximum
  ) {
    throw new Error(
      `PROJECT_STATE_FILE_INVALID: expected a bounded regular file of at most ${maximum} bytes.`,
    );
  }
  let descriptor: number | undefined;
  try {
    const noFollow =
      typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
    descriptor = openSync(path, constants.O_RDONLY | noFollow);
    const opened = fstatSync(descriptor);
    if (
      !opened.isFile() ||
      (!options.allowEmpty && opened.size === 0) ||
      opened.size > maximum ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino
    ) {
      throw new Error(
        "PROJECT_STATE_FILE_CHANGED: state file changed while opening.",
      );
    }
    const bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(
        descriptor,
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (count === 0) {
        throw new Error("PROJECT_STATE_FILE_CHANGED: state file became shorter.");
      }
      offset += count;
    }
    if (readSync(descriptor, Buffer.alloc(1), 0, 1, bytes.length) !== 0) {
      throw new Error("PROJECT_STATE_FILE_CHANGED: state file became larger.");
    }
    const after = lstatSync(path);
    if (
      !after.isFile() ||
      after.isSymbolicLink() ||
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.size !== opened.size
    ) {
      throw new Error("PROJECT_STATE_FILE_CHANGED: state file changed while reading.");
    }
    return bytes.toString("utf8");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}
