import { createHash } from "node:crypto";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };

export type CodeTestCase =
  | {
      id: string;
      input: JsonValue;
      expected: JsonValue;
      expectedErrorCode?: never;
    }
  | {
      id: string;
      input: JsonValue;
      expected?: never;
      expectedErrorCode: string;
    };

export interface CodeBaseFile {
  path: string;
  content: string;
  sha256: string;
}

export interface CodeMutation {
  id: string;
  description: string;
  content: string;
  contentHash: string;
  selectionHash: string;
}

export interface CodeEvaluationTask {
  id: string;
  repositoryId:
    | "work-order-ledger"
    | "equipment-desk"
    | "settlement-pipeline";
  family: string;
  difficulty: 1 | 2 | 3 | 4 | 5;
  objective: string;
  baseFiles: CodeBaseFile[];
  editablePaths: ["solution.mjs"];
  publicCases: CodeTestCase[];
  hiddenCases: CodeTestCase[];
  oracleContent: string;
  mutations: CodeMutation[];
  baselineExpectedFailureCaseIds: string[];
  taskHash: string;
}

export interface PublicCodeEvaluationTask {
  id: string;
  repositoryId: CodeEvaluationTask["repositoryId"];
  family: string;
  difficulty: CodeEvaluationTask["difficulty"];
  objective: string;
  prompt: string;
  baseFiles: CodeBaseFile[];
  editablePaths: ["solution.mjs"];
  publicCases: CodeTestCase[];
}

interface MutationDraft {
  id: string;
  description: string;
  content: string;
}

interface TaskDraft
  extends Omit<CodeEvaluationTask, "mutations" | "taskHash"> {
  mutationDrafts: MutationDraft[];
}

const DEFAULT_SEED = 20260731;

function source(value: string): string {
  return `${value.trim()}\n`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, stableValue(child)]),
    );
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function contentFile(path: string, content: string): CodeBaseFile {
  return { path, content, sha256: sha256(content) };
}

function replaceOnce(
  content: string,
  oldText: string,
  newText: string,
): string {
  const first = content.indexOf(oldText);
  if (first === -1 || content.indexOf(oldText, first + 1) !== -1) {
    throw new Error("Mutation replacement must match exactly once.");
  }
  return (
    content.slice(0, first) +
    newText +
    content.slice(first + oldText.length)
  );
}

function baseFiles(
  repositoryId: CodeEvaluationTask["repositoryId"],
  objective: string,
  solution: string,
): CodeBaseFile[] {
  const packageJson = `${JSON.stringify(
    {
      name: `chartermesh-evaluation-${repositoryId}`,
      private: true,
      type: "module",
      engines: { node: ">=24" },
    },
    null,
    2,
  )}\n`;
  const readme = [
    `# ${repositoryId}`,
    "",
    "This is a dependency-free CharterMesh code-evaluation fixture.",
    "`solution.mjs` must export `solve(input)` and return JSON-safe data.",
    "A rejected operation must throw an Error whose `code` is the required",
    "machine-readable error code. Do not read files, use the network, spawn",
    "processes, or mutate the supplied input.",
    "",
    "## Objective",
    "",
    objective,
    "",
  ].join("\n");
  return [
    contentFile("package.json", packageJson),
    contentFile("README.md", readme),
    contentFile("solution.mjs", solution),
  ];
}

function selectMutations(
  taskId: string,
  seed: number,
  drafts: MutationDraft[],
): CodeMutation[] {
  if (drafts.length < 3) {
    throw new Error(`Task '${taskId}' requires at least three mutations.`);
  }
  return drafts
    .map((draft) => ({
      ...draft,
      selectionHash: sha256(`${seed}:${taskId}:${draft.id}`),
    }))
    .sort((left, right) =>
      left.selectionHash.localeCompare(right.selectionHash)
    )
    .slice(0, 3)
    .map((draft) => ({
      ...draft,
      contentHash: sha256(draft.content),
    }));
}

function taskHashInput(
  task: Omit<CodeEvaluationTask, "taskHash"> | CodeEvaluationTask,
): Omit<CodeEvaluationTask, "taskHash"> {
  const { taskHash: _ignored, ...input } = task as CodeEvaluationTask;
  return input;
}

export function codeEvaluationTaskHash(
  task: Omit<CodeEvaluationTask, "taskHash"> | CodeEvaluationTask,
): string {
  return sha256(canonicalJson(taskHashInput(task)));
}

export function codeEvaluationSuiteHash(
  tasks: readonly CodeEvaluationTask[],
): string {
  return sha256(
    canonicalJson(
      [...tasks]
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((task) => ({
          id: task.id,
          taskHash: codeEvaluationTaskHash(task),
        })),
    ),
  );
}

export function projectPublicCodeTask(
  task: CodeEvaluationTask,
): PublicCodeEvaluationTask {
  return {
    id: task.id,
    repositoryId: task.repositoryId,
    family: task.family,
    difficulty: task.difficulty,
    objective: task.objective,
    prompt: [
      "Maintain the supplied dependency-free Node.js 24 repository.",
      task.objective,
      "Return the complete replacement text for solution.mjs only.",
      "Keep the exported API `solve(input)` and do not add dependencies,",
      "filesystem access, network access, subprocesses, or worker threads.",
    ].join("\n"),
    baseFiles: structuredClone(task.baseFiles),
    editablePaths: ["solution.mjs"],
    publicCases: structuredClone(task.publicCases),
  };
}

function workOrderTransitionTask(): TaskDraft {
  const objective = [
    "Implement strict work-item transitions without mutating the input.",
    "Allowed transitions are queued→running/canceled and",
    "running→completed/failed/canceled. All others throw",
    "`INVALID_TRANSITION`. Completing a running item additionally requires",
    "`approved === true`, otherwise throw `APPROVAL_REQUIRED`.",
    "A successful transition preserves fields, updates status, and increments",
    "the integer version by one. Invalid item shapes throw `INVALID_ITEM`.",
  ].join(" ");
  const baseline = source(`
function failure(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

export function solve(input) {
  if (!input || input.operation !== "transition" || !input.item) {
    failure("INVALID_ITEM");
  }
  const item = input.item;
  const allowed = {
    queued: ["running", "completed", "canceled"],
    running: ["completed", "failed", "canceled"],
  };
  if (!allowed[item.status]?.includes(input.to)) {
    failure("INVALID_TRANSITION");
  }
  return { ...item, status: input.to, version: item.version + 1 };
}
`);
  const oracle = source(`
function failure(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

export function solve(input) {
  if (
    !input ||
    input.operation !== "transition" ||
    !input.item ||
    typeof input.item.id !== "string" ||
    !Number.isInteger(input.item.version) ||
    typeof input.item.status !== "string" ||
    typeof input.to !== "string"
  ) {
    failure("INVALID_ITEM");
  }
  const item = input.item;
  const allowed = {
    queued: ["running", "canceled"],
    running: ["completed", "failed", "canceled"],
  };
  if (!allowed[item.status]?.includes(input.to)) {
    failure("INVALID_TRANSITION");
  }
  if (input.to === "completed" && item.approved !== true) {
    failure("APPROVAL_REQUIRED");
  }
  return { ...item, status: input.to, version: item.version + 1 };
}
`);
  return {
    id: "work-order-transition-001",
    repositoryId: "work-order-ledger",
    family: "state-transition",
    difficulty: 2,
    objective,
    baseFiles: baseFiles("work-order-ledger", objective, baseline),
    editablePaths: ["solution.mjs"],
    publicCases: [
      {
        id: "public-queued-running",
        input: {
          operation: "transition",
          item: {
            id: "WO-1",
            status: "queued",
            version: 2,
            approved: false,
          },
          to: "running",
        },
        expected: {
          id: "WO-1",
          status: "running",
          version: 3,
          approved: false,
        },
      },
      {
        id: "public-running-failed",
        input: {
          operation: "transition",
          item: {
            id: "WO-2",
            status: "running",
            version: 7,
            approved: false,
          },
          to: "failed",
        },
        expected: {
          id: "WO-2",
          status: "failed",
          version: 8,
          approved: false,
        },
      },
    ],
    hiddenCases: [
      {
        id: "hidden-no-direct-complete",
        input: {
          operation: "transition",
          item: {
            id: "WO-3",
            status: "queued",
            version: 1,
            approved: true,
          },
          to: "completed",
        },
        expectedErrorCode: "INVALID_TRANSITION",
      },
      {
        id: "hidden-completion-approval",
        input: {
          operation: "transition",
          item: {
            id: "WO-4",
            status: "running",
            version: 4,
            approved: false,
          },
          to: "completed",
        },
        expectedErrorCode: "APPROVAL_REQUIRED",
      },
      {
        id: "hidden-approved-completion",
        input: {
          operation: "transition",
          item: {
            id: "WO-5",
            status: "running",
            version: 4,
            approved: true,
            owner: "quality",
          },
          to: "completed",
        },
        expected: {
          id: "WO-5",
          status: "completed",
          version: 5,
          approved: true,
          owner: "quality",
        },
      },
      {
        id: "hidden-terminal-is-final",
        input: {
          operation: "transition",
          item: {
            id: "WO-6",
            status: "completed",
            version: 9,
            approved: true,
          },
          to: "running",
        },
        expectedErrorCode: "INVALID_TRANSITION",
      },
      {
        id: "hidden-invalid-version",
        input: {
          operation: "transition",
          item: {
            id: "WO-7",
            status: "queued",
            version: 1.5,
            approved: false,
          },
          to: "running",
        },
        expectedErrorCode: "INVALID_ITEM",
      },
    ],
    oracleContent: oracle,
    baselineExpectedFailureCaseIds: [
      "hidden-no-direct-complete",
      "hidden-completion-approval",
      "hidden-invalid-version",
    ],
    mutationDrafts: [
      {
        id: "allow-direct-complete",
        description: "Incorrectly permits queued items to complete directly.",
        content: replaceOnce(
          oracle,
          'queued: ["running", "canceled"]',
          'queued: ["running", "completed", "canceled"]',
        ),
      },
      {
        id: "remove-approval-gate",
        description: "Removes the completion approval requirement.",
        content: replaceOnce(
          oracle,
          'if (input.to === "completed" && item.approved !== true) {',
          'if (false && input.to === "completed" && item.approved !== true) {',
        ),
      },
      {
        id: "do-not-increment-version",
        description: "Leaves the work-item version unchanged.",
        content: replaceOnce(
          oracle,
          "version: item.version + 1",
          "version: item.version",
        ),
      },
      {
        id: "accept-fractional-version",
        description: "Accepts a non-integer version.",
        content: replaceOnce(
          oracle,
          "!Number.isInteger(input.item.version)",
          'typeof input.item.version !== "number"',
        ),
      },
    ],
  };
}

function workOrderIdempotencyTask(): TaskDraft {
  const objective = [
    "Implement idempotent work-item creation without mutating input arrays.",
    "Validate non-empty string id, idempotencyKey, and trimmed title;",
    "otherwise throw `INVALID_REQUEST`. A reused id with a different key",
    "throws `ID_CONFLICT` before key replay is considered. Otherwise, if the",
    "key already exists, return the original item and unchanged items with",
    "`created:false`. Otherwise append a queued item with the trimmed title",
    "and return `created:true`.",
  ].join(" ");
  const baseline = source(`
function failure(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

export function solve(input) {
  if (!input || input.operation !== "create" || !Array.isArray(input.existing)) {
    failure("INVALID_REQUEST");
  }
  const request = input.request;
  const item = {
    id: request.id,
    idempotencyKey: request.idempotencyKey,
    title: request.title.trim(),
    status: "queued",
  };
  return { created: true, item, items: [...input.existing, item] };
}
`);
  const oracle = source(`
function failure(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

export function solve(input) {
  if (
    !input ||
    input.operation !== "create" ||
    !Array.isArray(input.existing) ||
    !input.request ||
    typeof input.request.id !== "string" ||
    input.request.id.length === 0 ||
    typeof input.request.idempotencyKey !== "string" ||
    input.request.idempotencyKey.length === 0 ||
    typeof input.request.title !== "string" ||
    input.request.title.trim().length === 0
  ) {
    failure("INVALID_REQUEST");
  }
  const existing = input.existing;
  const request = input.request;
  const byId = existing.find((item) => item.id === request.id);
  if (byId && byId.idempotencyKey !== request.idempotencyKey) {
    failure("ID_CONFLICT");
  }
  const byKey = existing.find(
    (item) => item.idempotencyKey === request.idempotencyKey,
  );
  if (byKey) {
    return {
      created: false,
      item: { ...byKey },
      items: existing.map((item) => ({ ...item })),
    };
  }
  const item = {
    id: request.id,
    idempotencyKey: request.idempotencyKey,
    title: request.title.trim(),
    status: "queued",
  };
  return {
    created: true,
    item,
    items: [...existing.map((entry) => ({ ...entry })), item],
  };
}
`);
  const prior = {
    id: "WO-10",
    idempotencyKey: "key-10",
    title: "Inspect relay",
    status: "queued",
  };
  return {
    id: "work-order-idempotency-001",
    repositoryId: "work-order-ledger",
    family: "idempotent-create",
    difficulty: 2,
    objective,
    baseFiles: baseFiles("work-order-ledger", objective, baseline),
    editablePaths: ["solution.mjs"],
    publicCases: [
      {
        id: "public-first-create",
        input: {
          operation: "create",
          existing: [],
          request: {
            id: "WO-1",
            idempotencyKey: "key-1",
            title: "  Replace filter  ",
          },
        },
        expected: {
          created: true,
          item: {
            id: "WO-1",
            idempotencyKey: "key-1",
            title: "Replace filter",
            status: "queued",
          },
          items: [
            {
              id: "WO-1",
              idempotencyKey: "key-1",
              title: "Replace filter",
              status: "queued",
            },
          ],
        },
      },
      {
        id: "public-distinct-create",
        input: {
          operation: "create",
          existing: [prior],
          request: {
            id: "WO-11",
            idempotencyKey: "key-11",
            title: "Calibrate sensor",
          },
        },
        expected: {
          created: true,
          item: {
            id: "WO-11",
            idempotencyKey: "key-11",
            title: "Calibrate sensor",
            status: "queued",
          },
          items: [
            prior,
            {
              id: "WO-11",
              idempotencyKey: "key-11",
              title: "Calibrate sensor",
              status: "queued",
            },
          ],
        },
      },
    ],
    hiddenCases: [
      {
        id: "hidden-repeat-key",
        input: {
          operation: "create",
          existing: [prior],
          request: {
            id: "WO-99",
            idempotencyKey: "key-10",
            title: "Different payload",
          },
        },
        expected: {
          created: false,
          item: prior,
          items: [prior],
        },
      },
      {
        id: "hidden-id-conflict",
        input: {
          operation: "create",
          existing: [prior],
          request: {
            id: "WO-10",
            idempotencyKey: "new-key",
            title: "New request",
          },
        },
        expectedErrorCode: "ID_CONFLICT",
      },
      {
        id: "hidden-cross-record-conflict",
        input: {
          operation: "create",
          existing: [
            prior,
            {
              id: "WO-20",
              idempotencyKey: "key-20",
              title: "Second item",
              status: "queued",
            },
          ],
          request: {
            id: "WO-20",
            idempotencyKey: "key-10",
            title: "Conflicting request",
          },
        },
        expectedErrorCode: "ID_CONFLICT",
      },
      {
        id: "hidden-blank-title",
        input: {
          operation: "create",
          existing: [],
          request: {
            id: "WO-12",
            idempotencyKey: "key-12",
            title: "   ",
          },
        },
        expectedErrorCode: "INVALID_REQUEST",
      },
      {
        id: "hidden-empty-key",
        input: {
          operation: "create",
          existing: [],
          request: {
            id: "WO-13",
            idempotencyKey: "",
            title: "Valid title",
          },
        },
        expectedErrorCode: "INVALID_REQUEST",
      },
    ],
    oracleContent: oracle,
    baselineExpectedFailureCaseIds: [
      "hidden-repeat-key",
      "hidden-id-conflict",
      "hidden-cross-record-conflict",
      "hidden-blank-title",
      "hidden-empty-key",
    ],
    mutationDrafts: [
      {
        id: "never-deduplicate",
        description: "Disables lookup by idempotency key.",
        content: replaceOnce(
          oracle,
          "const byKey = existing.find(",
          "const byKey = [].find(",
        ),
      },
      {
        id: "ignore-id-conflict",
        description: "Allows a duplicate work-item id.",
        content: replaceOnce(
          oracle,
          "if (byId && byId.idempotencyKey !== request.idempotencyKey) {",
          "if (false && byId && byId.idempotencyKey !== request.idempotencyKey) {",
        ),
      },
      {
        id: "allow-blank-title",
        description: "Treats whitespace-only titles as valid.",
        content: replaceOnce(
          oracle,
          "input.request.title.trim().length === 0",
          "input.request.title.length === 0",
        ),
      },
      {
        id: "duplicate-reported-created",
        description: "Reports an idempotent replay as newly created.",
        content: replaceOnce(oracle, "created: false", "created: true"),
      },
    ],
  };
}

function equipmentOverlapTask(): TaskDraft {
  const objective = [
    "Determine reservation availability using half-open integer-minute",
    "intervals `[start,end)`. Validate the candidate and every reservation;",
    "invalid intervals throw `INVALID_INTERVAL`. Canceled reservations do not",
    "conflict. Return `{available, conflicts}` with conflict ids in input",
    "order. Adjacent intervals such as `[10,20)` and `[20,30)` do not overlap.",
  ].join(" ");
  const baseline = source(`
function failure(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

export function solve(input) {
  if (!input || !input.candidate || !Array.isArray(input.reservations)) {
    failure("INVALID_INTERVAL");
  }
  const candidate = input.candidate;
  const conflicts = input.reservations
    .filter((item) =>
      item.status !== "canceled" &&
      candidate.start <= item.end &&
      item.start <= candidate.end
    )
    .map((item) => item.id);
  return { available: conflicts.length === 0, conflicts };
}
`);
  const oracle = source(`
function failure(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function valid(interval) {
  return (
    interval &&
    Number.isInteger(interval.start) &&
    Number.isInteger(interval.end) &&
    interval.start < interval.end
  );
}

export function solve(input) {
  if (
    !input ||
    !valid(input.candidate) ||
    !Array.isArray(input.reservations) ||
    !input.reservations.every(valid)
  ) {
    failure("INVALID_INTERVAL");
  }
  const candidate = input.candidate;
  const conflicts = input.reservations
    .filter(
      (item) =>
        item.status !== "canceled" &&
        candidate.start < item.end &&
        item.start < candidate.end,
    )
    .map((item) => item.id);
  return { available: conflicts.length === 0, conflicts };
}
`);
  return {
    id: "equipment-overlap-001",
    repositoryId: "equipment-desk",
    family: "half-open-overlap",
    difficulty: 2,
    objective,
    baseFiles: baseFiles("equipment-desk", objective, baseline),
    editablePaths: ["solution.mjs"],
    publicCases: [
      {
        id: "public-clear-window",
        input: {
          candidate: { start: 50, end: 60 },
          reservations: [
            { id: "R-1", start: 10, end: 20, status: "active" },
          ],
        },
        expected: { available: true, conflicts: [] },
      },
      {
        id: "public-basic-overlap",
        input: {
          candidate: { start: 15, end: 25 },
          reservations: [
            { id: "R-1", start: 10, end: 20, status: "active" },
          ],
        },
        expected: { available: false, conflicts: ["R-1"] },
      },
    ],
    hiddenCases: [
      {
        id: "hidden-adjacent-after",
        input: {
          candidate: { start: 20, end: 30 },
          reservations: [
            { id: "R-1", start: 10, end: 20, status: "active" },
          ],
        },
        expected: { available: true, conflicts: [] },
      },
      {
        id: "hidden-adjacent-before",
        input: {
          candidate: { start: 10, end: 20 },
          reservations: [
            { id: "R-2", start: 20, end: 30, status: "active" },
          ],
        },
        expected: { available: true, conflicts: [] },
      },
      {
        id: "hidden-canceled-overlap",
        input: {
          candidate: { start: 12, end: 18 },
          reservations: [
            { id: "R-3", start: 10, end: 20, status: "canceled" },
          ],
        },
        expected: { available: true, conflicts: [] },
      },
      {
        id: "hidden-multiple-input-order",
        input: {
          candidate: { start: 15, end: 35 },
          reservations: [
            { id: "R-9", start: 30, end: 40, status: "active" },
            { id: "R-4", start: 10, end: 20, status: "active" },
          ],
        },
        expected: { available: false, conflicts: ["R-9", "R-4"] },
      },
      {
        id: "hidden-zero-width",
        input: {
          candidate: { start: 20, end: 20 },
          reservations: [],
        },
        expectedErrorCode: "INVALID_INTERVAL",
      },
    ],
    oracleContent: oracle,
    baselineExpectedFailureCaseIds: [
      "hidden-adjacent-after",
      "hidden-adjacent-before",
      "hidden-zero-width",
    ],
    mutationDrafts: [
      {
        id: "closed-candidate-start",
        description: "Treats an end/start boundary as overlapping.",
        content: replaceOnce(
          oracle,
          "candidate.start < item.end",
          "candidate.start <= item.end",
        ),
      },
      {
        id: "closed-candidate-end",
        description: "Treats a start/end boundary as overlapping.",
        content: replaceOnce(
          oracle,
          "item.start < candidate.end",
          "item.start <= candidate.end",
        ),
      },
      {
        id: "include-canceled",
        description: "Includes canceled reservations in conflicts.",
        content: replaceOnce(
          oracle,
          'item.status !== "canceled" &&',
          "true &&",
        ),
      },
      {
        id: "allow-empty-interval",
        description: "Accepts a zero-width interval.",
        content: replaceOnce(
          oracle,
          "interval.start < interval.end",
          "interval.start <= interval.end",
        ),
      },
    ],
  };
}

function equipmentMaintenanceTask(): TaskDraft {
  const objective = [
    "Authorize a reservation only when equipment is active and its valid",
    "half-open request interval does not overlap any `scheduled` maintenance",
    "window. Retired or maintenance-state equipment throws",
    "`EQUIPMENT_UNAVAILABLE`; invalid intervals throw `INVALID_INTERVAL`;",
    "a scheduled overlap throws `MAINTENANCE_CONFLICT`. Completed maintenance",
    "and adjacent windows do not block. Success returns `{allowed:true}`.",
  ].join(" ");
  const baseline = source(`
function failure(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

export function solve(input) {
  if (!input || !input.equipment || input.equipment.status !== "active") {
    failure("EQUIPMENT_UNAVAILABLE");
  }
  return { allowed: true };
}
`);
  const oracle = source(`
function failure(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function valid(interval) {
  return (
    interval &&
    Number.isInteger(interval.start) &&
    Number.isInteger(interval.end) &&
    interval.start < interval.end
  );
}

export function solve(input) {
  if (!input || !input.equipment || input.equipment.status !== "active") {
    failure("EQUIPMENT_UNAVAILABLE");
  }
  if (
    !valid(input.requested) ||
    !Array.isArray(input.maintenance) ||
    !input.maintenance.every(valid)
  ) {
    failure("INVALID_INTERVAL");
  }
  const overlaps = input.maintenance.some(
    (window) =>
      window.status === "scheduled" &&
      input.requested.start < window.end &&
      window.start < input.requested.end,
  );
  if (overlaps) failure("MAINTENANCE_CONFLICT");
  return { allowed: true };
}
`);
  return {
    id: "equipment-maintenance-001",
    repositoryId: "equipment-desk",
    family: "maintenance-lockout",
    difficulty: 2,
    objective,
    baseFiles: baseFiles("equipment-desk", objective, baseline),
    editablePaths: ["solution.mjs"],
    publicCases: [
      {
        id: "public-active-clear",
        input: {
          equipment: { id: "EQ-1", status: "active" },
          requested: { start: 10, end: 20 },
          maintenance: [],
        },
        expected: { allowed: true },
      },
      {
        id: "public-retired",
        input: {
          equipment: { id: "EQ-2", status: "retired" },
          requested: { start: 10, end: 20 },
          maintenance: [],
        },
        expectedErrorCode: "EQUIPMENT_UNAVAILABLE",
      },
    ],
    hiddenCases: [
      {
        id: "hidden-scheduled-overlap",
        input: {
          equipment: { id: "EQ-3", status: "active" },
          requested: { start: 15, end: 25 },
          maintenance: [
            { id: "M-1", start: 20, end: 30, status: "scheduled" },
          ],
        },
        expectedErrorCode: "MAINTENANCE_CONFLICT",
      },
      {
        id: "hidden-adjacent-maintenance",
        input: {
          equipment: { id: "EQ-4", status: "active" },
          requested: { start: 10, end: 20 },
          maintenance: [
            { id: "M-2", start: 20, end: 30, status: "scheduled" },
          ],
        },
        expected: { allowed: true },
      },
      {
        id: "hidden-completed-overlap",
        input: {
          equipment: { id: "EQ-5", status: "active" },
          requested: { start: 10, end: 20 },
          maintenance: [
            { id: "M-3", start: 12, end: 18, status: "completed" },
          ],
        },
        expected: { allowed: true },
      },
      {
        id: "hidden-equipment-maintenance-state",
        input: {
          equipment: { id: "EQ-6", status: "maintenance" },
          requested: { start: 10, end: 20 },
          maintenance: [],
        },
        expectedErrorCode: "EQUIPMENT_UNAVAILABLE",
      },
      {
        id: "hidden-invalid-maintenance-window",
        input: {
          equipment: { id: "EQ-7", status: "active" },
          requested: { start: 10, end: 20 },
          maintenance: [
            { id: "M-4", start: 30, end: 30, status: "scheduled" },
          ],
        },
        expectedErrorCode: "INVALID_INTERVAL",
      },
    ],
    oracleContent: oracle,
    baselineExpectedFailureCaseIds: [
      "hidden-scheduled-overlap",
      "hidden-invalid-maintenance-window",
    ],
    mutationDrafts: [
      {
        id: "ignore-maintenance",
        description: "Never detects a maintenance conflict.",
        content: replaceOnce(
          oracle,
          "const overlaps = input.maintenance.some(",
          "const overlaps = [].some(",
        ),
      },
      {
        id: "closed-maintenance-boundary",
        description: "Blocks an adjacent maintenance window.",
        content: replaceOnce(
          oracle,
          "window.start < input.requested.end",
          "window.start <= input.requested.end",
        ),
      },
      {
        id: "block-completed-maintenance",
        description: "Treats completed maintenance as scheduled.",
        content: replaceOnce(
          oracle,
          'window.status === "scheduled"',
          'window.status !== "canceled"',
        ),
      },
      {
        id: "skip-maintenance-validation",
        description: "Does not validate maintenance intervals.",
        content: replaceOnce(
          oracle,
          "!input.maintenance.every(valid)",
          "false",
        ),
      },
    ],
  };
}

function settlementCentsTask(): TaskDraft {
  const objective = [
    "Parse a canonical non-negative decimal amount into integer cents without",
    "floating-point rounding. Accept only `0` or a non-zero digit followed by",
    "digits, optionally followed by one or two decimal digits. Reject signs,",
    "whitespace, leading zeroes, more than two decimals, and values whose cents",
    "exceed Number.MAX_SAFE_INTEGER with `INVALID_AMOUNT`. Return",
    "`{cents, normalized}` where normalized always has two decimal digits.",
  ].join(" ");
  const baseline = source(`
function failure(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

export function solve(input) {
  const amount = input?.amount;
  const numeric = Number(amount);
  if (!Number.isFinite(numeric) || numeric < 0) failure("INVALID_AMOUNT");
  const cents = Math.round(numeric * 100);
  return { cents, normalized: (cents / 100).toFixed(2) };
}
`);
  const oracle = source(`
function failure(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

export function solve(input) {
  const amount = input?.amount;
  if (
    typeof amount !== "string" ||
    !/^(?:0|[1-9][0-9]*)(?:\\.[0-9]{1,2})?$/.test(amount)
  ) {
    failure("INVALID_AMOUNT");
  }
  const [whole, fraction = ""] = amount.split(".");
  const fractionPadded = fraction.padEnd(2, "0");
  const centsBig = BigInt(whole) * 100n + BigInt(fractionPadded);
  if (centsBig > BigInt(Number.MAX_SAFE_INTEGER)) {
    failure("INVALID_AMOUNT");
  }
  const cents = Number(centsBig);
  return {
    cents,
    normalized: \`\${whole}.\${fractionPadded}\`,
  };
}
`);
  return {
    id: "settlement-cents-001",
    repositoryId: "settlement-pipeline",
    family: "exact-money-parse",
    difficulty: 2,
    objective,
    baseFiles: baseFiles("settlement-pipeline", objective, baseline),
    editablePaths: ["solution.mjs"],
    publicCases: [
      {
        id: "public-two-decimals",
        input: { amount: "12.30" },
        expected: { cents: 1230, normalized: "12.30" },
      },
      {
        id: "public-whole",
        input: { amount: "7" },
        expected: { cents: 700, normalized: "7.00" },
      },
    ],
    hiddenCases: [
      {
        id: "hidden-one-decimal",
        input: { amount: "0.1" },
        expected: { cents: 10, normalized: "0.10" },
      },
      {
        id: "hidden-three-decimals",
        input: { amount: "1.005" },
        expectedErrorCode: "INVALID_AMOUNT",
      },
      {
        id: "hidden-leading-zero",
        input: { amount: "01.00" },
        expectedErrorCode: "INVALID_AMOUNT",
      },
      {
        id: "hidden-whitespace",
        input: { amount: " 1.00" },
        expectedErrorCode: "INVALID_AMOUNT",
      },
      {
        id: "hidden-unsafe-cents",
        input: { amount: "90071992547409.92" },
        expectedErrorCode: "INVALID_AMOUNT",
      },
      {
        id: "hidden-negative",
        input: { amount: "-1.00" },
        expectedErrorCode: "INVALID_AMOUNT",
      },
    ],
    oracleContent: oracle,
    baselineExpectedFailureCaseIds: [
      "hidden-three-decimals",
      "hidden-leading-zero",
      "hidden-whitespace",
      "hidden-unsafe-cents",
    ],
    mutationDrafts: [
      {
        id: "allow-three-decimals",
        description: "Accepts a third fractional digit.",
        content: replaceOnce(oracle, "{1,2}", "{1,3}"),
      },
      {
        id: "allow-leading-zero",
        description: "Accepts a non-canonical leading zero.",
        content: replaceOnce(oracle, "(?:0|[1-9][0-9]*)", "[0-9]+"),
      },
      {
        id: "skip-safe-integer-bound",
        description: "Does not reject cents above the safe integer limit.",
        content: replaceOnce(
          oracle,
          "if (centsBig > BigInt(Number.MAX_SAFE_INTEGER)) {",
          "if (false && centsBig > BigInt(Number.MAX_SAFE_INTEGER)) {",
        ),
      },
      {
        id: "truncate-one-decimal",
        description: "Pads the fraction on the wrong side.",
        content: replaceOnce(
          oracle,
          'fraction.padEnd(2, "0")',
          'fraction.padStart(2, "0")',
        ),
      },
    ],
  };
}

function settlementRefundTask(): TaskDraft {
  const objective = [
    "Apply an idempotent refund using integer cents without mutating input.",
    "captureCents and refund amount must be positive safe integers and events",
    "must be an array, otherwise throw `INVALID_REFUND`. If request.id already",
    "names an identical refund, return unchanged events with `accepted:false`.",
    "A reused id with different type or amount throws `IDEMPOTENCY_CONFLICT`.",
    "Cumulative refunds may not exceed captureCents; otherwise throw",
    "`REFUND_EXCEEDS_CAPTURE`. Success appends the refund and returns totals.",
  ].join(" ");
  const baseline = source(`
function failure(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

export function solve(input) {
  const request = input.request;
  if (request.amountCents > input.captureCents) {
    failure("REFUND_EXCEEDS_CAPTURE");
  }
  const event = {
    id: request.id,
    type: "refund",
    amountCents: request.amountCents,
  };
  const events = [...input.events, event];
  const refundedCents = events.reduce(
    (sum, item) => sum + (item.type === "refund" ? item.amountCents : 0),
    0,
  );
  return {
    accepted: true,
    refundedCents,
    remainingCents: input.captureCents - refundedCents,
    events,
  };
}
`);
  const oracle = source(`
function failure(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function positiveSafeInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

export function solve(input) {
  if (
    !input ||
    !positiveSafeInteger(input.captureCents) ||
    !Array.isArray(input.events) ||
    !input.request ||
    typeof input.request.id !== "string" ||
    input.request.id.length === 0 ||
    !positiveSafeInteger(input.request.amountCents)
  ) {
    failure("INVALID_REFUND");
  }
  const request = input.request;
  const alreadyRefunded = input.events.reduce(
    (sum, event) =>
      sum + (event.type === "refund" ? event.amountCents : 0),
    0,
  );
  if (alreadyRefunded > input.captureCents) {
    failure("REFUND_EXCEEDS_CAPTURE");
  }
  const priorById = input.events.find((event) => event.id === request.id);
  if (priorById) {
    if (
      priorById.type !== "refund" ||
      priorById.amountCents !== request.amountCents
    ) {
      failure("IDEMPOTENCY_CONFLICT");
    }
    return {
      accepted: false,
      refundedCents: alreadyRefunded,
      remainingCents: input.captureCents - alreadyRefunded,
      events: input.events.map((event) => ({ ...event })),
    };
  }
  if (alreadyRefunded + request.amountCents > input.captureCents) {
    failure("REFUND_EXCEEDS_CAPTURE");
  }
  const event = {
    id: request.id,
    type: "refund",
    amountCents: request.amountCents,
  };
  const events = [...input.events.map((entry) => ({ ...entry })), event];
  const refundedCents = alreadyRefunded + request.amountCents;
  return {
    accepted: true,
    refundedCents,
    remainingCents: input.captureCents - refundedCents,
    events,
  };
}
`);
  const refund100 = { id: "RF-1", type: "refund", amountCents: 100 };
  return {
    id: "settlement-refund-001",
    repositoryId: "settlement-pipeline",
    family: "idempotent-refund",
    difficulty: 3,
    objective,
    baseFiles: baseFiles("settlement-pipeline", objective, baseline),
    editablePaths: ["solution.mjs"],
    publicCases: [
      {
        id: "public-first-refund",
        input: {
          captureCents: 1000,
          events: [],
          request: { id: "RF-1", amountCents: 250 },
        },
        expected: {
          accepted: true,
          refundedCents: 250,
          remainingCents: 750,
          events: [
            { id: "RF-1", type: "refund", amountCents: 250 },
          ],
        },
      },
      {
        id: "public-second-refund",
        input: {
          captureCents: 1000,
          events: [refund100],
          request: { id: "RF-2", amountCents: 200 },
        },
        expected: {
          accepted: true,
          refundedCents: 300,
          remainingCents: 700,
          events: [
            refund100,
            { id: "RF-2", type: "refund", amountCents: 200 },
          ],
        },
      },
    ],
    hiddenCases: [
      {
        id: "hidden-cumulative-limit",
        input: {
          captureCents: 1000,
          events: [
            { id: "RF-1", type: "refund", amountCents: 800 },
          ],
          request: { id: "RF-2", amountCents: 300 },
        },
        expectedErrorCode: "REFUND_EXCEEDS_CAPTURE",
      },
      {
        id: "hidden-idempotent-repeat",
        input: {
          captureCents: 1000,
          events: [
            { id: "RF-1", type: "refund", amountCents: 250 },
          ],
          request: { id: "RF-1", amountCents: 250 },
        },
        expected: {
          accepted: false,
          refundedCents: 250,
          remainingCents: 750,
          events: [
            { id: "RF-1", type: "refund", amountCents: 250 },
          ],
        },
      },
      {
        id: "hidden-over-refunded-replay",
        input: {
          captureCents: 1000,
          events: [
            { id: "RF-1", type: "refund", amountCents: 1100 },
          ],
          request: { id: "RF-1", amountCents: 1100 },
        },
        expectedErrorCode: "REFUND_EXCEEDS_CAPTURE",
      },
      {
        id: "hidden-idempotency-conflict",
        input: {
          captureCents: 1000,
          events: [
            { id: "RF-1", type: "refund", amountCents: 250 },
          ],
          request: { id: "RF-1", amountCents: 300 },
        },
        expectedErrorCode: "IDEMPOTENCY_CONFLICT",
      },
      {
        id: "hidden-event-type-conflict",
        input: {
          captureCents: 1000,
          events: [
            { id: "RF-3", type: "capture", amountCents: 1000 },
          ],
          request: { id: "RF-3", amountCents: 1000 },
        },
        expectedErrorCode: "IDEMPOTENCY_CONFLICT",
      },
      {
        id: "hidden-zero-refund",
        input: {
          captureCents: 1000,
          events: [],
          request: { id: "RF-4", amountCents: 0 },
        },
        expectedErrorCode: "INVALID_REFUND",
      },
    ],
    oracleContent: oracle,
    baselineExpectedFailureCaseIds: [
      "hidden-cumulative-limit",
      "hidden-idempotent-repeat",
      "hidden-over-refunded-replay",
      "hidden-idempotency-conflict",
      "hidden-event-type-conflict",
      "hidden-zero-refund",
    ],
    mutationDrafts: [
      {
        id: "individual-limit-only",
        description: "Compares only the new refund to the capture.",
        content: replaceOnce(
          oracle,
          "alreadyRefunded + request.amountCents > input.captureCents",
          "request.amountCents > input.captureCents",
        ),
      },
      {
        id: "no-idempotency",
        description: "Disables lookup for an existing request id.",
        content: replaceOnce(
          oracle,
          "const priorById = input.events.find(",
          "const priorById = [].find(",
        ),
      },
      {
        id: "accept-conflicting-replay",
        description: "Treats a conflicting replay as idempotent.",
        content: replaceOnce(
          oracle,
          'priorById.type !== "refund" ||',
          "false ||",
        ),
      },
      {
        id: "allow-zero-refund",
        description: "Accepts a zero-cent refund.",
        content: replaceOnce(oracle, "value > 0", "value >= 0"),
      },
    ],
  };
}

export function generatePilotCodeSuite(
  seed = DEFAULT_SEED,
): CodeEvaluationTask[] {
  if (!Number.isSafeInteger(seed)) {
    throw new Error("Code-evaluation seed must be a safe integer.");
  }
  const drafts = [
    workOrderTransitionTask(),
    workOrderIdempotencyTask(),
    equipmentOverlapTask(),
    equipmentMaintenanceTask(),
    settlementCentsTask(),
    settlementRefundTask(),
  ];
  return drafts.map(({ mutationDrafts, ...draft }) => {
    const withoutHash: Omit<CodeEvaluationTask, "taskHash"> = {
      ...draft,
      mutations: selectMutations(draft.id, seed, mutationDrafts),
    };
    return {
      ...withoutHash,
      taskHash: codeEvaluationTaskHash(withoutHash),
    };
  });
}
