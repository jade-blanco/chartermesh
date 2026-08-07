import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  verifyToolRuntimeReceipt,
  type ToolEvidenceReceipt,
  type ToolExecutionEvidence,
} from "../../runtime/src/tool-runtime.ts";
import type {
  AuditRecord,
  AcceptanceCriterion,
  ArtifactProducerReport,
  ArtifactReviewDecision,
  ArtifactEvidence,
  AttemptRecord,
  DashboardProjection,
  DecisionPacket,
  ModelInvocationRecord,
  OperationalState,
  OutboxDelivery,
  OutboxRecord,
  PendingToolCall,
  RuntimeBudgets,
  ScheduleTickRecord,
  ToolCallApproval,
  ToolCallDenial,
  ToolExecutionEvidenceRecord,
  UserAction,
  UserInputRecord,
  WaitCondition,
  WorkItem,
  WorkItemDecisionContract,
  WorkItemPage,
  WorkStatus,
} from "./types.ts";
import { assertMaintenanceInactive } from "./maintenance.ts";
import {
  buildDecisionPacket,
  canonicalHash,
  createDecisionContract,
  normalizeArtifactProducerReport,
  parseLegacyArtifactProducerReport,
} from "./decision-packet.ts";

type Row = Record<string, unknown>;
const DEFAULT_MAX_ARTIFACT_BYTES = 1_048_576;
const DEFAULT_MAX_WORK_ITEM_ARTIFACT_BYTES = 10_485_760;

function now(): string {
  return new Date().toISOString();
}

function asWorkItem(row: Row): WorkItem {
  const wait = row.wait_type
    ? {
        type: String(row.wait_type) as WaitCondition["type"],
        reason: String(row.wait_reason),
        ...(row.wait_reference
          ? { reference: String(row.wait_reference) }
          : {}),
        ...(row.resume_at ? { resumeAt: String(row.resume_at) } : {}),
        createdBy: row.wait_created_by
          ? String(row.wait_created_by)
          : "system:unknown",
      }
    : null;
  return {
    id: String(row.id),
    rootId: String(row.root_id),
    parentId: row.parent_id ? String(row.parent_id) : null,
    title: String(row.title),
    summary: String(row.summary),
    ownerRole: String(row.owner_role),
    executionTarget: String(row.execution_target),
    status: String(row.status) as WorkItem["status"],
    availability: String(row.availability) as WorkItem["availability"],
    priority: Number(row.priority),
    version: Number(row.version),
    wait,
    nextAction: String(row.next_action),
    archivedAt: row.archived_at ? String(row.archived_at) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function assertText(value: string, label: string): string {
  const clean = value.trim();
  if (!clean) throw new Error(`${label} is required.`);
  if (clean.length > 4_000) throw new Error(`${label} is too long.`);
  return clean;
}

function optionalBoundedInteger(
  value: number | undefined,
  label: string,
  maximum: number,
): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a non-negative finite number.`);
  }
  return Math.min(maximum, Math.floor(value));
}

function parseStoredDecisionContract(
  value: unknown,
  storedHash: string,
): WorkItemDecisionContract {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Stored decision contract is invalid.");
  }
  const record = value as Record<string, unknown>;
  if (
    record.apiVersion !== "chartermesh.dev/work-decision-contract/v1alpha1" ||
    typeof record.objective !== "string" ||
    typeof record.decisionQuestion !== "string" ||
    record.reviewPolicy !== "human_required" ||
    !["user", "workflow_stage", "legacy_derived"].includes(
      String(record.source),
    ) ||
    !Array.isArray(record.acceptanceCriteria) ||
    record.acceptanceCriteria.length > 100
  ) {
    throw new Error("Stored decision contract is invalid.");
  }
  const acceptanceCriteria = record.acceptanceCriteria.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Stored decision contract criterion is invalid.");
    }
    const criterion = value as Record<string, unknown>;
    if (
      typeof criterion.id !== "string" ||
      !/^[A-Za-z0-9._-]{1,96}$/u.test(criterion.id) ||
      typeof criterion.text !== "string" ||
      !criterion.text.trim() ||
      criterion.text.length > 4_000 ||
      typeof criterion.critical !== "boolean" ||
      !Array.isArray(criterion.evidenceRequirements) ||
      criterion.evidenceRequirements.length > 20
    ) {
      throw new Error("Stored decision contract criterion is invalid.");
    }
    const evidenceRequirements = criterion.evidenceRequirements.map(
      (value) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          throw new Error("Stored decision evidence requirement is invalid.");
        }
        const requirement = value as Record<string, unknown>;
        if (
          requirement.kind === "tool" &&
          typeof requirement.toolName === "string" &&
          requirement.toolName.trim().length > 0 &&
          requirement.toolName.length <= 256
        ) {
          return { kind: "tool" as const, toolName: requirement.toolName };
        }
        if (
          requirement.kind === "validator" &&
          typeof requirement.validatorId === "string" &&
          requirement.validatorId.trim().length > 0 &&
          requirement.validatorId.length <= 256
        ) {
          return {
            kind: "validator" as const,
            validatorId: requirement.validatorId,
          };
        }
        throw new Error("Stored decision evidence requirement is invalid.");
      },
    );
    return {
      id: criterion.id,
      text: criterion.text,
      critical: criterion.critical,
      evidenceRequirements,
    };
  });
  const rebuilt = createDecisionContract({
    objective: record.objective,
    decisionQuestion: record.decisionQuestion,
    acceptanceCriteria,
    source: record.source as WorkItemDecisionContract["source"],
  });
  if (
    typeof record.contractHash !== "string" ||
    record.contractHash !== storedHash ||
    rebuilt.contractHash !== storedHash
  ) {
    throw new Error("Stored decision contract hash does not match its content.");
  }
  return rebuilt;
}

function transaction<T>(database: DatabaseSync, operation: () => T): T {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

const AUDIT_PAYLOAD_FIELDS = new Set([
  "paused",
  "rootId",
  "ownerRole",
  "executionTarget",
  "predecessorId",
  "runId",
  "attemptId",
  "leaseId",
  "generation",
  "expiresAt",
  "errorCode",
  "artifactId",
  "sha256",
  "approvalId",
  "denialId",
  "decision",
  "artifactHash",
  "completedPredecessor",
  "callHash",
  "toolName",
  "evidenceId",
  "status",
  "inputHash",
  "outputHash",
  "scheduleId",
  "tickKey",
  "invocationId",
  "engineId",
  "modelId",
  "measurementStatus",
  "parentAttemptId",
  "roleId",
  "kind",
  "handoffHash",
  "commandId",
  "stageIndex",
  "cycle",
  "stageKind",
  "packetHash",
  "producerReportHash",
  "activeReviewMs",
  "detailsOpenCount",
  "reviewMeasurementStatus",
  "responseHash",
]);

function allowlistedAuditPayload(
  value: unknown,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).flatMap(
      ([key, entryValue]) => {
        if (!AUDIT_PAYLOAD_FIELDS.has(key)) return [];
        if (
          entryValue === null ||
          typeof entryValue === "boolean" ||
          (typeof entryValue === "number" &&
            Number.isFinite(entryValue)) ||
          (typeof entryValue === "string" &&
            entryValue.length <= 512)
        ) {
          return [[key, entryValue]];
        }
        return [];
      },
    ),
  );
}

function safeAuditActor(value: unknown): string {
  const actor = String(value);
  return /^(?:human|role|runner|system):[A-Za-z0-9._-]{1,96}$/u.test(actor)
    ? actor
    : "system:unknown";
}

function asAuditRecord(row: Row): AuditRecord {
  let payload: unknown = {};
  try {
    payload = JSON.parse(String(row.payload_json));
  } catch {
    payload = {};
  }
  return {
    id: Number(row.id),
    type: String(row.event_type),
    workItemId: row.work_item_id ? String(row.work_item_id) : null,
    actor: safeAuditActor(row.actor),
    createdAt: String(row.created_at),
    payload: allowlistedAuditPayload(payload),
  };
}

function asInvocation(row: Row): ModelInvocationRecord {
  return {
    id: String(row.id),
    attemptId: String(row.attempt_id),
    engineId: String(row.engine_id),
    modelId: String(row.model_id),
    status: String(row.status) as ModelInvocationRecord["status"],
    inputTokens:
      row.input_tokens === null || row.input_tokens === undefined
        ? null
        : Number(row.input_tokens),
    outputTokens:
      row.output_tokens === null || row.output_tokens === undefined
        ? null
        : Number(row.output_tokens),
    cost:
      row.cost === null || row.cost === undefined ? null : Number(row.cost),
    measurementStatus: String(
      row.measurement_status,
    ) as ModelInvocationRecord["measurementStatus"],
    startedAt: String(row.started_at),
    finishedAt: row.finished_at ? String(row.finished_at) : null,
  };
}

function asAttempt(row: Row): AttemptRecord {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    parentAttemptId: row.parent_attempt_id
      ? String(row.parent_attempt_id)
      : null,
    roleId: row.role_id ? String(row.role_id) : null,
    kind: String(row.kind ?? "primary") as AttemptRecord["kind"],
    attemptNo: Number(row.attempt_no),
    status: String(row.status) as AttemptRecord["status"],
    startedAt: String(row.started_at),
    finishedAt: row.finished_at ? String(row.finished_at) : null,
    errorCode: row.error_code ? String(row.error_code) : null,
    errorMessage: row.error_message ? String(row.error_message) : null,
  };
}

function outboxPayload(value: unknown): Record<string, unknown> {
  try {
    const parsed = JSON.parse(String(value)) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function asOutbox(row: Row): OutboxRecord {
  return {
    id: Number(row.id),
    eventId: Number(row.event_id),
    eventType: String(row.event_type),
    payload: outboxPayload(row.payload_json),
    createdAt: String(row.created_at),
    attemptCount: Number(row.attempt_count ?? 0),
    nextAttemptAt: row.next_attempt_at
      ? String(row.next_attempt_at)
      : null,
    lastErrorCode: row.last_error_code
      ? String(row.last_error_code)
      : null,
    dispatchedAt: row.dispatched_at ? String(row.dispatched_at) : null,
    deadLetteredAt: row.dead_lettered_at
      ? String(row.dead_lettered_at)
      : null,
    claimedAt: row.claimed_at ? String(row.claimed_at) : null,
    claimOwner: row.claim_owner ? String(row.claim_owner) : null,
  };
}

function asScheduleTick(row: Row): ScheduleTickRecord {
  return {
    id: String(row.id),
    scheduleId: String(row.schedule_id),
    tickKey: String(row.tick_key),
    status: String(row.status) as ScheduleTickRecord["status"],
    workItemId: row.work_item_id ? String(row.work_item_id) : null,
    startedAt: String(row.started_at),
    finishedAt: row.finished_at ? String(row.finished_at) : null,
    errorCode: row.error_code ? String(row.error_code) : null,
  };
}

function workCursor(row: Row): string {
  return Buffer.from(
    JSON.stringify({
      createdAt: String(row.created_at),
      id: String(row.id),
    }),
    "utf8",
  ).toString("base64url");
}

function parseWorkCursor(
  value: string | undefined,
): { createdAt: string; id: string } | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as { createdAt?: unknown; id?: unknown };
    if (
      typeof parsed.createdAt !== "string" ||
      typeof parsed.id !== "string" ||
      !/^work-\d{6,}$/u.test(parsed.id)
    ) {
      throw new Error("invalid");
    }
    return { createdAt: parsed.createdAt, id: parsed.id };
  } catch {
    throw new Error("WORK_ITEM_CURSOR_INVALID");
  }
}

export class ControlPlane {
  private readonly database: DatabaseSync;
  private readonly artifactDirectory: string;
  private readonly budgets?: RuntimeBudgets;
  private readonly maintenanceDirectory: string;

  constructor(
    database: DatabaseSync,
    artifactDirectory: string,
    options: {
      budgets?: RuntimeBudgets;
      maintenanceDirectory?: string;
    } = {},
  ) {
    this.database = database;
    this.artifactDirectory = artifactDirectory;
    this.budgets = options.budgets;
    this.maintenanceDirectory =
      options.maintenanceDirectory ?? join(artifactDirectory, "..");
    mkdirSync(artifactDirectory, { recursive: true });
  }

  private assertWritable(): void {
    assertMaintenanceInactive(this.maintenanceDirectory);
  }

  private transact<T>(operation: () => T): T {
    this.assertWritable();
    return transaction(this.database, operation);
  }

  private assertRunBudgets(): void {
    if (this.operationalState().paused) {
      throw new Error("OPERATIONS_PAUSED");
    }
    if (!this.budgets) return;
    const active = this.database
      .prepare(
        "SELECT COUNT(*) AS count FROM runs WHERE status = 'running'",
      )
      .get() as Row;
    if (Number(active.count) >= this.budgets.maxConcurrentRuns) {
      throw new Error("BUDGET_CONCURRENT_RUNS_EXCEEDED");
    }
    const dayStart = new Date();
    dayStart.setUTCHours(0, 0, 0, 0);
    const daily = this.database
      .prepare("SELECT COUNT(*) AS count FROM runs WHERE started_at >= ?")
      .get(dayStart.toISOString()) as Row;
    if (Number(daily.count) >= this.budgets.maxDailyModelStarts) {
      throw new Error("BUDGET_DAILY_MODEL_STARTS_EXCEEDED");
    }
    const monthStart = new Date();
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);
    const spend = this.database
      .prepare(
        `SELECT COALESCE(SUM(cost), 0) AS cost
         FROM model_invocations WHERE started_at >= ?`,
      )
      .get(monthStart.toISOString()) as Row;
    if (Number(spend.cost) >= this.budgets.monthlyCostLimitUsd) {
      throw new Error("BUDGET_MONTHLY_COST_EXCEEDED");
    }
    if (this.budgets.unknownCostPolicy === "block") {
      const unknown = this.database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM model_invocations
           WHERE started_at >= ? AND cost IS NULL`,
        )
        .get(monthStart.toISOString()) as Row;
      if (Number(unknown.count) > 0) {
        throw new Error("BUDGET_UNKNOWN_COST_BLOCKED");
      }
    }
  }

  private assertModelStartBudget(): void {
    if (!this.budgets) return;
    const dayStart = new Date();
    dayStart.setUTCHours(0, 0, 0, 0);
    const daily = this.database
      .prepare(`
        SELECT COUNT(*) AS count
        FROM model_invocations
        WHERE started_at >= ?
      `)
      .get(dayStart.toISOString()) as Row;
    if (Number(daily.count) >= this.budgets.maxDailyModelStarts) {
      throw new Error("BUDGET_DAILY_MODEL_STARTS_EXCEEDED");
    }
  }

  operationalState(): OperationalState {
    const row = this.database
      .prepare("SELECT value FROM metadata WHERE key = 'operations:pause'")
      .get() as Row | undefined;
    if (!row) {
      return {
        paused: false,
        pausedAt: null,
        reason: null,
        actor: null,
      };
    }
    try {
      const value = JSON.parse(String(row.value)) as {
        pausedAt?: unknown;
        reason?: unknown;
        actor?: unknown;
      };
      return {
        paused: true,
        pausedAt:
          typeof value.pausedAt === "string" ? value.pausedAt : null,
        reason: typeof value.reason === "string" ? value.reason : null,
        actor: typeof value.actor === "string" ? value.actor : null,
      };
    } catch {
      throw new Error("OPERATIONS_PAUSE_STATE_INVALID");
    }
  }

  pauseOperations(input: {
    reason: string;
    actor: string;
    idempotencyKey: string;
  }): OperationalState {
    return this.command(input.idempotencyKey, "operations.pause", () => {
      if (!input.actor.startsWith("human:")) {
        throw new Error("OPERATIONS_PAUSE_REQUIRES_HUMAN");
      }
      const state: OperationalState = {
        paused: true,
        pausedAt: now(),
        reason: assertText(input.reason, "reason"),
        actor: input.actor,
      };
      this.database
        .prepare(`
          INSERT INTO metadata(key, value) VALUES ('operations:pause', ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value
        `)
        .run(JSON.stringify(state));
      this.event("operations.paused", null, input.actor, { paused: true });
      return state;
    });
  }

  resumeOperations(input: {
    actor: string;
    idempotencyKey: string;
  }): OperationalState {
    return this.command(input.idempotencyKey, "operations.resume", () => {
      if (!input.actor.startsWith("human:")) {
        throw new Error("OPERATIONS_RESUME_REQUIRES_HUMAN");
      }
      this.database
        .prepare("DELETE FROM metadata WHERE key = 'operations:pause'")
        .run();
      this.event("operations.resumed", null, input.actor, {
        paused: false,
      });
      return this.operationalState();
    });
  }

  private nextId(prefix: string): string {
    const key = `sequence:${prefix}`;
    const row = this.database
      .prepare("SELECT value FROM metadata WHERE key = ?")
      .get(key) as Row | undefined;
    const next = Number(row?.value ?? 0) + 1;
    this.database
      .prepare(`
        INSERT INTO metadata(key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `)
      .run(key, String(next));
    return `${prefix}-${String(next).padStart(6, "0")}`;
  }

  private event(
    type: string,
    workItemId: string | null,
    actor: string,
    payload: Record<string, unknown> = {},
  ): void {
    const stamp = now();
    const result = this.database
      .prepare(`
        INSERT INTO events(event_type, work_item_id, actor, payload_json, created_at)
        VALUES (?, ?, ?, ?, ?)
      `)
      .run(type, workItemId, actor, JSON.stringify(payload), stamp);
    this.database
      .prepare(`
        INSERT INTO outbox(event_id, event_type, payload_json, created_at)
        VALUES (?, ?, ?, ?)
      `)
      .run(result.lastInsertRowid, type, JSON.stringify(payload), stamp);
  }

  auditRecords(): AuditRecord[] {
    const records: AuditRecord[] = [];
    let afterId = 0;
    for (;;) {
      const page = this.auditRecordsPage({ afterId, limit: 1_000 });
      records.push(...page);
      if (page.length < 1_000) return records;
      afterId = page.at(-1)!.id;
    }
  }

  auditRecordCount(): number {
    const row = this.database
      .prepare("SELECT COUNT(*) AS count FROM events")
      .get() as Row;
    return Number(row.count);
  }

  auditRecordsPage(
    options: { afterId?: number; limit?: number } = {},
  ): AuditRecord[] {
    const afterId = Math.max(0, Math.floor(options.afterId ?? 0));
    const limit = Math.min(
      1_000,
      Math.max(1, Math.floor(options.limit ?? 250)),
    );
    return (
      this.database
        .prepare(
          `SELECT id, event_type, work_item_id, actor, payload_json, created_at
           FROM events
           WHERE id > ?
           ORDER BY id ASC
           LIMIT ?`,
        )
        .all(afterId, limit) as Row[]
    ).map(asAuditRecord);
  }

  claimOutboxBatch(input: {
    owner: string;
    limit?: number;
    claimSeconds?: number;
  }): OutboxDelivery[] {
    return this.transact(() => {
      const owner = assertText(input.owner, "owner");
      const limit = Math.min(
        100,
        Math.max(1, Math.floor(input.limit ?? 25)),
      );
      const staleBefore = new Date(
        Date.now() -
          Math.min(
            3_600,
            Math.max(10, Math.floor(input.claimSeconds ?? 60)),
          ) *
            1_000,
      ).toISOString();
      this.database
        .prepare(`
          UPDATE outbox
          SET claimed_at = NULL, claim_owner = NULL
          WHERE dispatched_at IS NULL
            AND dead_lettered_at IS NULL
            AND claimed_at IS NOT NULL
            AND claimed_at <= ?
        `)
        .run(staleBefore);
      const rows = this.database
        .prepare(`
          SELECT *
          FROM outbox
          WHERE dispatched_at IS NULL
            AND dead_lettered_at IS NULL
            AND claimed_at IS NULL
            AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
          ORDER BY id
          LIMIT ?
        `)
        .all(now(), limit) as Row[];
      if (rows.length === 0) return [];
      const claimedAt = now();
      const claim = this.database.prepare(`
        UPDATE outbox
        SET claimed_at = ?, claim_owner = ?
        WHERE id = ?
          AND dispatched_at IS NULL
          AND dead_lettered_at IS NULL
          AND claimed_at IS NULL
      `);
      return rows.flatMap((row) => {
        const result = claim.run(claimedAt, owner, Number(row.id));
        if (Number(result.changes) === 0) return [];
        const mapped = asOutbox({ ...row, claimed_at: claimedAt, claim_owner: owner });
        return [
          {
            id: mapped.id,
            eventId: mapped.eventId,
            eventType: mapped.eventType,
            payload: mapped.payload,
            createdAt: mapped.createdAt,
            attemptCount: mapped.attemptCount,
          },
        ];
      });
    });
  }

  acknowledgeOutbox(input: { id: number; owner: string }): OutboxRecord {
    return this.transact(() => {
      const stamp = now();
      const update = this.database
        .prepare(`
          UPDATE outbox
          SET dispatched_at = ?, claimed_at = NULL, claim_owner = NULL,
              next_attempt_at = NULL, last_error_code = NULL
          WHERE id = ? AND claim_owner = ?
            AND dispatched_at IS NULL AND dead_lettered_at IS NULL
        `)
        .run(stamp, input.id, assertText(input.owner, "owner"));
      if (Number(update.changes) === 0) {
        throw new Error("OUTBOX_CLAIM_NOT_OWNED");
      }
      return asOutbox(
        this.database.prepare("SELECT * FROM outbox WHERE id = ?").get(
          input.id,
        ) as Row,
      );
    });
  }

  failOutbox(input: {
    id: number;
    owner: string;
    errorCode: string;
    maxAttempts?: number;
    baseBackoffSeconds?: number;
  }): OutboxRecord {
    return this.transact(() => {
      const row = this.database
        .prepare(`
          SELECT * FROM outbox
          WHERE id = ? AND claim_owner = ?
            AND dispatched_at IS NULL AND dead_lettered_at IS NULL
        `)
        .get(input.id, assertText(input.owner, "owner")) as Row | undefined;
      if (!row) throw new Error("OUTBOX_CLAIM_NOT_OWNED");
      const attemptCount = Number(row.attempt_count ?? 0) + 1;
      const maxAttempts = Math.min(
        20,
        Math.max(1, Math.floor(input.maxAttempts ?? 5)),
      );
      const errorCode = /^[A-Z][A-Z0-9_]{1,79}$/u.test(input.errorCode)
        ? input.errorCode
        : "OUTBOX_HANDLER_FAILED";
      const deadLetteredAt =
        attemptCount >= maxAttempts ? now() : null;
      const base = Math.min(
        3_600,
        Math.max(1, Math.floor(input.baseBackoffSeconds ?? 2)),
      );
      const nextAttemptAt = deadLetteredAt
        ? null
        : new Date(
            Date.now() +
              Math.min(3_600, base * 2 ** (attemptCount - 1)) * 1_000,
          ).toISOString();
      this.database
        .prepare(`
          UPDATE outbox
          SET attempt_count = ?, next_attempt_at = ?,
              last_error_code = ?, dead_lettered_at = ?,
              claimed_at = NULL, claim_owner = NULL
          WHERE id = ?
        `)
        .run(
          attemptCount,
          nextAttemptAt,
          errorCode,
          deadLetteredAt,
          input.id,
        );
      return asOutbox(
        this.database.prepare("SELECT * FROM outbox WHERE id = ?").get(
          input.id,
        ) as Row,
      );
    });
  }

  listOutbox(
    options: { deadLettersOnly?: boolean; limit?: number } = {},
  ): OutboxRecord[] {
    const limit = Math.min(
      1_000,
      Math.max(1, Math.floor(options.limit ?? 100)),
    );
    return (
      this.database
        .prepare(`
          SELECT * FROM outbox
          WHERE (? = 0 OR dead_lettered_at IS NOT NULL)
          ORDER BY id DESC
          LIMIT ?
        `)
        .all(options.deadLettersOnly ? 1 : 0, limit) as Row[]
    ).map(asOutbox);
  }

  retryDeadLetter(input: {
    id: number;
    actor: string;
    idempotencyKey: string;
  }): OutboxRecord {
    return this.command(input.idempotencyKey, "outbox.dead-letter.retry", () => {
      if (!input.actor.startsWith("human:")) {
        throw new Error("OUTBOX_RETRY_REQUIRES_HUMAN");
      }
      const update = this.database
        .prepare(`
          UPDATE outbox
          SET attempt_count = 0, next_attempt_at = NULL,
              last_error_code = NULL, dead_lettered_at = NULL,
              claimed_at = NULL, claim_owner = NULL
          WHERE id = ? AND dead_lettered_at IS NOT NULL
        `)
        .run(input.id);
      if (Number(update.changes) === 0) {
        throw new Error("OUTBOX_DEAD_LETTER_NOT_FOUND");
      }
      this.event("outbox.dead-letter.retried", null, input.actor);
      return asOutbox(
        this.database.prepare("SELECT * FROM outbox WHERE id = ?").get(
          input.id,
        ) as Row,
      );
    });
  }

  latestScheduleTick(scheduleId: string): ScheduleTickRecord | null {
    const row = this.database
      .prepare(`
        SELECT * FROM schedule_ticks
        WHERE schedule_id = ?
        ORDER BY started_at DESC, id DESC
        LIMIT 1
      `)
      .get(scheduleId) as Row | undefined;
    return row ? asScheduleTick(row) : null;
  }

  activeScheduleTick(scheduleId: string): ScheduleTickRecord | null {
    const row = this.database
      .prepare(`
        SELECT * FROM schedule_ticks
        WHERE schedule_id = ? AND status = 'started'
        ORDER BY started_at DESC, id DESC
        LIMIT 1
      `)
      .get(scheduleId) as Row | undefined;
    return row ? asScheduleTick(row) : null;
  }

  beginScheduleTick(input: {
    scheduleId: string;
    tickKey: string;
    workItemId: string | null;
    status?: "started" | "skipped_no_work" | "skipped_overlap";
    startedAt?: string;
  }): ScheduleTickRecord {
    return this.transact(() => {
      const scheduleId = assertText(input.scheduleId, "scheduleId");
      const tickKey = assertText(input.tickKey, "tickKey");
      if (input.workItemId) this.get(input.workItemId);
      const status = input.status ?? "started";
      const id = `schedule-tick-${createHash("sha256")
        .update(`${scheduleId}\0${tickKey}`)
        .digest("hex")
        .slice(0, 24)}`;
      const requestedStamp = input.startedAt
        ? new Date(input.startedAt)
        : null;
      if (requestedStamp && !Number.isFinite(requestedStamp.getTime())) {
        throw new Error("startedAt must be an ISO-8601 timestamp.");
      }
      const stamp = requestedStamp?.toISOString() ?? now();
      const insert = this.database
        .prepare(`
          INSERT OR IGNORE INTO schedule_ticks(
            id, schedule_id, tick_key, status, work_item_id,
            started_at, finished_at, error_code
          ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
        `)
        .run(
          id,
          scheduleId,
          tickKey,
          status,
          input.workItemId,
          stamp,
          status === "started" ? null : stamp,
        );
      const row = this.database
        .prepare(`
          SELECT * FROM schedule_ticks
          WHERE schedule_id = ? AND tick_key = ?
        `)
        .get(scheduleId, tickKey) as Row;
      if (Number(insert.changes) > 0) {
        this.event(
          `schedule.tick.${status}`,
          input.workItemId,
          "system:scheduler",
          {
            scheduleId,
            tickKey,
            status,
          },
        );
      }
      return asScheduleTick(row);
    });
  }

  finishScheduleTick(input: {
    id: string;
    status: "succeeded" | "failed";
    errorCode?: string;
  }): ScheduleTickRecord {
    return this.transact(() => {
      const errorCode =
        input.errorCode &&
        /^[A-Z][A-Z0-9_]{1,79}$/u.test(input.errorCode)
          ? input.errorCode
          : input.status === "failed"
            ? "SCHEDULE_RUN_FAILED"
            : null;
      const update = this.database
        .prepare(`
          UPDATE schedule_ticks
          SET status = ?, finished_at = ?, error_code = ?
          WHERE id = ? AND status = 'started'
        `)
        .run(input.status, now(), errorCode, input.id);
      const row = this.database
        .prepare("SELECT * FROM schedule_ticks WHERE id = ?")
        .get(input.id) as Row | undefined;
      if (!row) throw new Error(`Unknown schedule tick '${input.id}'.`);
      if (Number(update.changes) > 0) {
        this.event(
          `schedule.tick.${input.status}`,
          row.work_item_id ? String(row.work_item_id) : null,
          "system:scheduler",
          {
            scheduleId: String(row.schedule_id),
            tickKey: String(row.tick_key),
            status: input.status,
            ...(errorCode ? { errorCode } : {}),
          },
        );
      }
      return asScheduleTick(row);
    });
  }

  listScheduleTicks(scheduleId?: string): ScheduleTickRecord[] {
    const rows = scheduleId
      ? (this.database
          .prepare(`
            SELECT * FROM schedule_ticks
            WHERE schedule_id = ?
            ORDER BY started_at DESC, id DESC
          `)
          .all(scheduleId) as Row[])
      : (this.database
          .prepare(`
            SELECT * FROM schedule_ticks
            ORDER BY started_at DESC, id DESC
          `)
          .all() as Row[]);
    return rows.map(asScheduleTick);
  }

  private command<T>(
    idempotencyKey: string,
    command: string,
    operation: () => T,
  ): T {
    assertText(idempotencyKey, "idempotencyKey");
    return this.transact(() => {
      const replay = this.database
        .prepare(`
          SELECT command, response_json
          FROM command_results
          WHERE idempotency_key = ?
        `)
        .get(idempotencyKey) as Row | undefined;
      if (replay) {
        if (replay.command !== command) {
          throw new Error(
            "Idempotency key was already used for another command.",
          );
        }
        return JSON.parse(String(replay.response_json)) as T;
      }
      const result = operation();
      this.database
        .prepare(`
          INSERT INTO command_results(
            idempotency_key, command, response_json, created_at
          ) VALUES (?, ?, ?, ?)
        `)
        .run(idempotencyKey, command, JSON.stringify(result), now());
      return result;
    });
  }

  intake(input: {
    title: string;
    summary: string;
    ownerRole?: string;
    executionTarget?: string;
    priority?: number;
    actor: string;
    idempotencyKey: string;
    parentId?: string;
    rootId?: string;
    requiredTools?: string[];
    decisionQuestion?: string;
    acceptanceCriteria?: AcceptanceCriterion[];
  }): WorkItem {
    return this.command(input.idempotencyKey, "intake", () => {
      const id = this.nextId("work");
      const stamp = now();
      const rootId = input.rootId ?? id;
      this.database
        .prepare(`
          INSERT INTO work_items(
            id, root_id, parent_id, title, summary, owner_role,
            execution_target, status, availability, priority, version,
            next_action, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'requested', 'ready', ?, 1, ?, ?, ?)
        `)
        .run(
          id,
          rootId,
          input.parentId ?? null,
          assertText(input.title, "title"),
          assertText(input.summary, "summary"),
          input.ownerRole?.trim() || "unassigned",
          input.executionTarget?.trim() || "unassigned",
          Math.max(0, Math.min(100, input.priority ?? 50)),
          "Assign a role and execution target.",
          stamp,
          stamp,
        );
      const requiredTools = [
        ...new Set(
          (input.requiredTools ?? []).map((toolName) =>
            assertText(toolName, "required tool")
          ),
        ),
      ];
      if (requiredTools.length > 20) {
        throw new Error("A work item can require at most 20 tools.");
      }
      for (const toolName of requiredTools) {
        this.database
          .prepare(`
            INSERT INTO work_item_required_tools(
              work_item_id, tool_name, created_at
            ) VALUES (?, ?, ?)
          `)
          .run(id, toolName, stamp);
      }
      const suppliedCriteria = (input.acceptanceCriteria ?? []).map(
        (criterion, index): AcceptanceCriterion => ({
          id: /^[A-Za-z0-9._-]{1,96}$/u.test(criterion.id)
            ? criterion.id
            : `criterion-${index + 1}`,
          text: assertText(criterion.text, "acceptance criterion"),
          critical: Boolean(criterion.critical),
          evidenceRequirements: (criterion.evidenceRequirements ?? [])
            .slice(0, 20)
            .map((requirement) =>
              requirement.kind === "tool"
                ? {
                    kind: "tool" as const,
                    toolName: assertText(requirement.toolName, "required tool"),
                  }
                : {
                    kind: "validator" as const,
                    validatorId: assertText(
                      requirement.validatorId,
                      "validatorId",
                    ),
                  },
            ),
        }),
      );
      if (suppliedCriteria.length > 100) {
        throw new Error("A work item can define at most 100 acceptance criteria.");
      }
      const criterionToolNames = new Set(
        suppliedCriteria.flatMap(({ evidenceRequirements }) =>
          evidenceRequirements.flatMap((requirement) =>
            requirement.kind === "tool" ? [requirement.toolName] : [],
          ),
        ),
      );
      const acceptanceCriteria: AcceptanceCriterion[] = [
        ...(suppliedCriteria.length > 0
          ? suppliedCriteria
          : [
              {
                id: "objective",
                text: assertText(input.summary, "summary"),
                critical: true,
                evidenceRequirements: [],
              },
            ]),
        ...requiredTools
          .filter((toolName) => !criterionToolNames.has(toolName))
          .map((toolName, index) => ({
            id: `required-tool-${index + 1}`,
            text: `Required tool ${toolName} succeeds.`,
            critical: true,
            evidenceRequirements: [{ kind: "tool" as const, toolName }],
          })),
      ];
      if (acceptanceCriteria.length > 100) {
        throw new Error("A work item can define at most 100 acceptance criteria.");
      }
      if (
        new Set(acceptanceCriteria.map(({ id: criterionId }) => criterionId))
          .size !== acceptanceCriteria.length
      ) {
        throw new Error("Acceptance criterion ids must be unique.");
      }
      const contract = createDecisionContract({
        objective: input.summary,
        decisionQuestion: input.decisionQuestion,
        acceptanceCriteria,
        source:
          input.decisionQuestion || suppliedCriteria.length > 0
            ? "user"
            : "legacy_derived",
      });
      this.database
        .prepare(`
          INSERT INTO work_item_decision_contracts(
            work_item_id, schema_version, contract_json, contract_hash,
            created_at
          ) VALUES (?, ?, ?, ?, ?)
        `)
        .run(
          id,
          contract.apiVersion,
          JSON.stringify(contract),
          contract.contractHash,
          stamp,
        );
      this.event("work.intake.created", id, input.actor, { rootId });
      return this.get(id);
    });
  }

  requiredTools(id: string): string[] {
    this.get(id);
    const rows = this.database
      .prepare(`
        SELECT tool_name
        FROM work_item_required_tools
        WHERE work_item_id = ?
        ORDER BY tool_name
      `)
      .all(id) as Row[];
    return rows.map((row) => String(row.tool_name));
  }

  decisionContract(id: string): WorkItemDecisionContract {
    const item = this.get(id);
    const row = this.database
      .prepare(`
        SELECT contract_json, contract_hash
        FROM work_item_decision_contracts
        WHERE work_item_id = ?
      `)
      .get(id) as Row | undefined;
    if (row) {
      return parseStoredDecisionContract(
        JSON.parse(String(row.contract_json)) as unknown,
        String(row.contract_hash),
      );
    }
    const requiredTools = this.requiredTools(id);
    return createDecisionContract({
      objective: item.summary,
      acceptanceCriteria: [
        {
          id: "objective",
          text: item.summary,
          critical: true,
          evidenceRequirements: [],
        },
        ...requiredTools.map((toolName, index) => ({
          id: `required-tool-${index + 1}`,
          text: `Required tool ${toolName} succeeds.`,
          critical: true,
          evidenceRequirements: [{ kind: "tool" as const, toolName }],
        })),
      ],
      source: "legacy_derived",
    });
  }

  decisionPacket(id: string): DecisionPacket | null {
    const item = this.get(id);
    const projected = this.projectCurrentDecisionPacket(item);
    if (!projected) return null;
    const stored = this.database
      .prepare(`
        SELECT packet_json
        FROM decision_packets
        WHERE work_item_id = ? AND superseded_at IS NULL
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      `)
      .get(id) as Row | undefined;
    if (stored) {
      const packet = JSON.parse(String(stored.packet_json)) as DecisionPacket;
      if (
        packet.kind === projected.kind &&
        packet.binding.subjectHash === projected.binding.subjectHash &&
        packet.binding.contractHash === projected.binding.contractHash &&
        packet.binding.producerReportHash ===
          projected.binding.producerReportHash &&
        packet.binding.evidenceSetHash === projected.binding.evidenceSetHash &&
        packet.binding.workItemVersion === item.version &&
        packet.binding.packetHash === projected.binding.packetHash
      ) {
        return projected;
      }
    }
    return projected;
  }

  private projectCurrentDecisionPacket(item: WorkItem): DecisionPacket | null {
    const contract = this.decisionContract(item.id);
    const toolEvidence = this.listToolEvidence(item.id);
    if (item.status === "review_pending") {
      const artifact = this.latestArtifact(item.id);
      if (!artifact) return null;
      return buildDecisionPacket({
        workItem: item,
        contract,
        subject: {
          kind: "artifact",
          artifactId: artifact.id,
          artifactHash: artifact.sha256,
          mediaType: artifact.mediaType,
        },
        artifactContent: artifact.content,
        ...(artifact.producerReport
          ? { producerReport: artifact.producerReport }
          : {}),
        toolEvidence: toolEvidence.filter(
          ({ runId }) => runId === artifact.runId,
        ),
        createdAt: artifact.createdAt,
      });
    }
    if (
      item.status === "in_progress" &&
      item.availability === "approval_waiting" &&
      item.wait?.type === "approval" &&
      item.wait.reference
    ) {
      const pending = this.listPendingToolCalls(item.id).find(
        ({ callHash, status }) =>
          callHash === item.wait?.reference && status === "approval_required",
      );
      if (!pending) return null;
      return buildDecisionPacket({
        workItem: item,
        contract,
        subject: {
          kind: "tool_call",
          callHash: pending.callHash,
          toolName: pending.toolName,
        },
        toolEvidence: toolEvidence.filter(
          ({ runId }) => runId === pending.runId,
        ),
        createdAt: pending.createdAt,
      });
    }
    if (item.availability === "user_input_waiting" && item.wait) {
      return buildDecisionPacket({
        workItem: item,
        contract,
        subject: {
          kind: "user_input",
          reference: item.wait.reference ?? item.wait.reason,
        },
        toolEvidence: [],
        createdAt: item.updatedAt,
        question: item.wait.reason,
      });
    }
    return null;
  }

  private replaceDecisionPacket(packet: DecisionPacket, createdAt: string): void {
    this.database
      .prepare(`
        UPDATE decision_packets
        SET superseded_at = ?
        WHERE work_item_id = ? AND superseded_at IS NULL
      `)
      .run(createdAt, packet.workItemId);
    this.database
      .prepare(`
        UPDATE approvals
        SET superseded_at = ?
        WHERE work_item_id = ? AND superseded_at IS NULL
      `)
      .run(createdAt, packet.workItemId);
    this.database
      .prepare(`
        INSERT INTO decision_packets(
          id, work_item_id, kind, subject_hash, contract_hash,
          evidence_set_hash, packet_hash, packet_json, created_at,
          superseded_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
      `)
      .run(
        this.nextId("decision-packet"),
        packet.workItemId,
        packet.kind,
        packet.binding.subjectHash,
        packet.binding.contractHash,
        packet.binding.evidenceSetHash,
        packet.binding.packetHash,
        JSON.stringify(packet),
        createdAt,
      );
  }

  private ensureDecisionPacketStored(
    packet: DecisionPacket,
    createdAt: string,
  ): void {
    const active = this.database
      .prepare(`
        SELECT packet_hash
        FROM decision_packets
        WHERE work_item_id = ? AND superseded_at IS NULL
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      `)
      .get(packet.workItemId) as Row | undefined;
    if (active && String(active.packet_hash) === packet.binding.packetHash) {
      return;
    }
    this.replaceDecisionPacket(packet, createdAt);
  }

  latestUserInput(id: string): UserInputRecord | null {
    this.get(id);
    const row = this.database
      .prepare(`
        SELECT *
        FROM work_item_user_inputs
        WHERE work_item_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      `)
      .get(id) as Row | undefined;
    if (!row) return null;
    return {
      id: String(row.id),
      workItemId: String(row.work_item_id),
      reference: String(row.wait_reference),
      response: String(row.response),
      responseHash: String(row.response_hash),
      actor: String(row.actor),
      createdAt: String(row.created_at),
    };
  }

  provideUserInput(input: {
    id: string;
    packetHash: string;
    response: string;
    actor: string;
    idempotencyKey: string;
    activeReviewMs?: number;
    detailsOpenCount?: number;
  }): { input: Omit<UserInputRecord, "response">; workItem: WorkItem } {
    return this.command(input.idempotencyKey, "user.input.provide", () => {
      const current = this.get(input.id);
      if (!input.actor.startsWith("human:")) {
        throw new Error("User input authority must be a human actor.");
      }
      if (
        current.availability !== "user_input_waiting" ||
        current.wait?.type !== "user_input"
      ) {
        throw new Error("Work is not waiting for user input.");
      }
      const packet = this.decisionPacket(input.id);
      if (
        !packet ||
        packet.kind !== "user_input" ||
        packet.binding.packetHash !== input.packetHash
      ) {
        throw new Error("User input packet does not match the current request.");
      }
      const response = assertText(input.response, "user input response");
      const responseHash = createHash("sha256").update(response).digest("hex");
      const createdAt = now();
      this.ensureDecisionPacketStored(packet, createdAt);
      const record: UserInputRecord = {
        id: this.nextId("user-input"),
        workItemId: input.id,
        reference: current.wait.reference ?? current.wait.reason,
        response,
        responseHash,
        actor: input.actor,
        createdAt,
      };
      this.database
        .prepare(`
          INSERT INTO work_item_user_inputs(
            id, work_item_id, wait_reference, response, response_hash,
            actor, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          record.id,
          record.workItemId,
          record.reference,
          record.response,
          record.responseHash,
          record.actor,
          record.createdAt,
        );
      const nextStatus: WorkStatus =
        current.status === "requested" ? "requested" : "ready";
      this.database
        .prepare(`
          UPDATE work_items
          SET status = ?, availability = 'ready',
              wait_type = NULL, wait_reason = NULL, wait_reference = NULL,
              resume_at = NULL, wait_created_by = NULL,
              next_action = ?, version = version + 1, updated_at = ?
          WHERE id = ?
        `)
        .run(
          nextStatus,
          nextStatus === "requested"
            ? "Assign a role and execution target."
            : "Claim and continue with the supplied user input.",
          createdAt,
          input.id,
        );
      this.database
        .prepare(`
          UPDATE decision_packets
          SET superseded_at = ?
          WHERE work_item_id = ? AND superseded_at IS NULL
        `)
        .run(createdAt, input.id);
      const activeReviewMs = optionalBoundedInteger(
        input.activeReviewMs,
        "activeReviewMs",
        86_400_000,
      );
      const detailsOpenCount = optionalBoundedInteger(
        input.detailsOpenCount,
        "detailsOpenCount",
        10_000,
      );
      this.event("user.input.provided", input.id, input.actor, {
        packetHash: input.packetHash,
        responseHash,
        ...(activeReviewMs === undefined
          ? {}
          : {
              activeReviewMs,
              reviewMeasurementStatus: "estimated",
            }),
        ...(detailsOpenCount === undefined
          ? {}
          : { detailsOpenCount }),
      });
      const { response: _response, ...receipt } = record;
      return { input: receipt, workItem: this.get(input.id) };
    });
  }

  triage(input: {
    id: string;
    ownerRole: string;
    executionTarget: string;
    actor: string;
    idempotencyKey: string;
    expectedVersion?: number;
  }): WorkItem {
    return this.command(input.idempotencyKey, "triage", () => {
      const current = this.get(input.id);
      this.assertVersion(current, input.expectedVersion);
      if (!["requested", "ready", "changes_requested"].includes(current.status)) {
        throw new Error("Only requested, ready, or change-requested work can be triaged.");
      }
      const stamp = now();
      this.database
        .prepare(`
          UPDATE work_items
          SET owner_role = ?, execution_target = ?, status = 'ready',
              availability = 'ready', next_action = 'Claim and start work.',
              wait_type = NULL, wait_reason = NULL, wait_reference = NULL,
              resume_at = NULL, wait_created_by = NULL,
              version = version + 1, updated_at = ?
          WHERE id = ?
        `)
        .run(
          assertText(input.ownerRole, "ownerRole"),
          assertText(input.executionTarget, "executionTarget"),
          stamp,
          input.id,
        );
      this.event("work.triaged", input.id, input.actor, {
        ownerRole: input.ownerRole,
        executionTarget: input.executionTarget,
      });
      return this.get(input.id);
    });
  }

  addDependency(input: {
    id: string;
    predecessorId: string;
    actor: string;
    idempotencyKey: string;
  }): WorkItem {
    return this.command(input.idempotencyKey, "dependency.add", () => {
      this.get(input.id);
      this.get(input.predecessorId);
      if (input.id === input.predecessorId) {
        throw new Error("Work cannot depend on itself.");
      }
      if (this.reachable(input.predecessorId, input.id)) {
        throw new Error("Dependency would create a cycle.");
      }
      this.database
        .prepare(`
          INSERT INTO dependencies(
            work_item_id, predecessor_id, relationship, active, created_at
          ) VALUES (?, ?, 'after', 1, ?)
          ON CONFLICT(work_item_id, predecessor_id)
          DO UPDATE SET active = 1
        `)
        .run(input.id, input.predecessorId, now());
      this.database
        .prepare(`
          UPDATE work_items
          SET availability = 'dependency_waiting',
              wait_type = 'predecessor',
              wait_reason = 'Waiting for predecessor work.',
              wait_reference = ?,
              wait_created_by = ?,
              next_action = 'Wait for predecessor completion.',
              version = version + 1,
              updated_at = ?
          WHERE id = ?
        `)
        .run(input.predecessorId, input.actor, now(), input.id);
      this.event("work.dependency.added", input.id, input.actor, {
        predecessorId: input.predecessorId,
      });
      return this.get(input.id);
    });
  }

  claim(input: {
    id: string;
    actor: string;
    idempotencyKey: string;
    expectedVersion?: number;
    leaseMinutes?: number;
  }): {
    workItem: WorkItem;
    runId: string;
    attemptId: string;
    leaseId: string;
    generation: number;
  } {
    return this.command(input.idempotencyKey, "work.claim", () => {
      const current = this.get(input.id);
      this.assertVersion(current, input.expectedVersion);
      if (
        current.availability !== "ready" ||
        !["ready", "changes_requested"].includes(current.status)
      ) {
        throw new Error("Work is not currently claimable.");
      }
      this.assertRunBudgets();
      const generationRow = this.database
        .prepare(`
          SELECT COALESCE(MAX(generation), 0) AS generation
          FROM runs WHERE work_item_id = ?
        `)
        .get(input.id) as Row;
      const generation = Number(generationRow.generation) + 1;
      const runId = this.nextId("run");
      const attemptId = this.nextId("attempt");
      const leaseId = this.nextId("lease");
      const stamp = now();
      const expiresAt = new Date(
        Date.now() + (input.leaseMinutes ?? 15) * 60_000,
      ).toISOString();
      this.database
        .prepare(`
          INSERT INTO runs(
            id, work_item_id, generation, status, execution_target, started_at
          ) VALUES (?, ?, ?, 'running', ?, ?)
        `)
        .run(
          runId,
          input.id,
          generation,
          current.executionTarget,
          stamp,
        );
      this.database
        .prepare(`
          INSERT INTO attempts(id, run_id, attempt_no, status, started_at)
          VALUES (?, ?, 1, 'running', ?)
        `)
        .run(attemptId, runId, stamp);
      this.database
        .prepare(`
          INSERT INTO leases(
            id, run_id, attempt_id, owner, generation, acquired_at,
            heartbeat_at, expires_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          leaseId,
          runId,
          attemptId,
          input.actor,
          generation,
          stamp,
          stamp,
          expiresAt,
        );
      this.database
        .prepare(`
          UPDATE work_items
          SET status = 'in_progress', next_action = 'Submit progress or artifact.',
              version = version + 1, updated_at = ?
          WHERE id = ?
        `)
        .run(stamp, input.id);
      this.event("work.claimed", input.id, input.actor, {
        runId,
        attemptId,
        leaseId,
        generation,
      });
      return {
        workItem: this.get(input.id),
        runId,
        attemptId,
        leaseId,
        generation,
      };
    });
  }

  startChildAttempt(input: {
    parentAttemptId: string;
    roleId: string;
    actor: string;
    maxChildren?: number;
    handoffHash?: string;
    commandId?: string;
    stageIndex?: number;
    cycle?: number;
    stageKind?: "c_level" | "worker";
  }): AttemptRecord {
    return this.transact(() => {
      const parent = this.database
        .prepare(`
          SELECT a.id, a.run_id, a.kind, a.status, r.work_item_id,
                 r.status AS run_status
          FROM attempts a
          JOIN runs r ON r.id = a.run_id
          WHERE a.id = ?
        `)
        .get(input.parentAttemptId) as Row | undefined;
      if (
        !parent ||
        parent.status !== "running" ||
        parent.run_status !== "running"
      ) {
        throw new Error("Delegation parent attempt is not active.");
      }
      if (String(parent.kind ?? "primary") !== "primary") {
        throw new Error("Delegation depth is limited to one.");
      }
      const maxChildren = input.maxChildren ?? 4;
      if (
        !Number.isInteger(maxChildren) ||
        maxChildren < 1 ||
        maxChildren > 1_000
      ) {
        throw new Error("maxChildren must be an integer from 1 to 1000.");
      }
      if (
        input.handoffHash !== undefined &&
        !/^[a-f0-9]{64}$/u.test(input.handoffHash)
      ) {
        throw new Error("handoffHash must be a lowercase SHA-256 digest.");
      }
      if (
        input.commandId !== undefined &&
        (input.commandId.trim().length === 0 || input.commandId.length > 128)
      ) {
        throw new Error("commandId must contain 1 to 128 characters.");
      }
      if (
        input.stageIndex !== undefined &&
        (!Number.isInteger(input.stageIndex) || input.stageIndex < 0)
      ) {
        throw new Error("stageIndex must be a non-negative integer.");
      }
      if (
        input.cycle !== undefined &&
        (!Number.isInteger(input.cycle) || input.cycle < 1)
      ) {
        throw new Error("cycle must be a positive integer.");
      }
      if (
        input.stageKind !== undefined &&
        !["c_level", "worker"].includes(input.stageKind)
      ) {
        throw new Error("stageKind must be c_level or worker.");
      }
      const count = this.database
        .prepare(`
          SELECT COUNT(*) AS count
          FROM attempts
          WHERE parent_attempt_id = ?
        `)
        .get(input.parentAttemptId) as Row;
      if (Number(count.count) >= maxChildren) {
        throw new Error("Delegation child limit reached.");
      }
      const number = this.database
        .prepare(`
          SELECT COALESCE(MAX(attempt_no), 0) + 1 AS attempt_no
          FROM attempts
          WHERE run_id = ?
        `)
        .get(String(parent.run_id)) as Row;
      const id = this.nextId("attempt");
      const roleId = assertText(input.roleId, "roleId").slice(0, 100);
      const stamp = now();
      this.database
        .prepare(`
          INSERT INTO attempts(
            id, run_id, parent_attempt_id, role_id, kind,
            attempt_no, status, started_at
          ) VALUES (?, ?, ?, ?, 'delegated', ?, 'running', ?)
        `)
        .run(
          id,
          String(parent.run_id),
          input.parentAttemptId,
          roleId,
          Number(number.attempt_no),
          stamp,
        );
      this.event(
        "attempt.delegated.started",
        String(parent.work_item_id),
        input.actor,
        {
          attemptId: id,
          parentAttemptId: input.parentAttemptId,
          roleId,
          kind: "delegated",
          runId: String(parent.run_id),
          ...(input.handoffHash
            ? { handoffHash: assertText(input.handoffHash, "handoffHash") }
            : {}),
          ...(input.commandId
            ? { commandId: assertText(input.commandId, "commandId") }
            : {}),
          ...(input.stageIndex === undefined
            ? {}
            : { stageIndex: input.stageIndex }),
          ...(input.cycle === undefined ? {} : { cycle: input.cycle }),
          ...(input.stageKind ? { stageKind: input.stageKind } : {}),
        },
      );
      return asAttempt(
        this.database
          .prepare("SELECT * FROM attempts WHERE id = ?")
          .get(id) as Row,
      );
    });
  }

  finishChildAttempt(input: {
    id: string;
    status: "succeeded" | "failed" | "canceled";
    actor: string;
    errorCode?: string;
    errorMessage?: string;
  }): AttemptRecord {
    return this.transact(() => {
      const current = this.database
        .prepare(`
          SELECT a.*, r.work_item_id
          FROM attempts a
          JOIN runs r ON r.id = a.run_id
          WHERE a.id = ?
        `)
        .get(input.id) as Row | undefined;
      if (!current || String(current.kind) !== "delegated") {
        throw new Error(`Unknown delegated attempt '${input.id}'.`);
      }
      if (current.status === "running") {
        const errorCode = input.errorCode
          ? assertText(input.errorCode, "errorCode").slice(0, 100)
          : null;
        const errorMessage = input.errorMessage
          ? assertText(input.errorMessage, "errorMessage").slice(0, 1_000)
          : null;
        this.database
          .prepare(`
            UPDATE attempts
            SET status = ?, finished_at = ?, error_code = ?,
                error_message = ?
            WHERE id = ? AND status = 'running'
          `)
          .run(
            input.status,
            now(),
            errorCode,
            errorMessage,
            input.id,
          );
        this.event(
          `attempt.delegated.${input.status}`,
          String(current.work_item_id),
          input.actor,
          {
            attemptId: input.id,
            parentAttemptId: String(current.parent_attempt_id),
            roleId: String(current.role_id),
            kind: "delegated",
            runId: String(current.run_id),
            ...(errorCode ? { errorCode } : {}),
          },
        );
      }
      return asAttempt(
        this.database
          .prepare("SELECT * FROM attempts WHERE id = ?")
          .get(input.id) as Row,
      );
    });
  }

  listAttempts(runId?: string): AttemptRecord[] {
    const rows = runId
      ? (this.database
          .prepare(`
            SELECT * FROM attempts
            WHERE run_id = ?
            ORDER BY attempt_no, id
          `)
          .all(runId) as Row[])
      : (this.database
          .prepare(`
            SELECT * FROM attempts
            ORDER BY started_at, attempt_no, id
          `)
          .all() as Row[]);
    return rows.map(asAttempt);
  }

  requestRunCancellation(input: {
    id: string;
    actor: string;
    idempotencyKey: string;
  }): { workItemId: string; runId: string; requestedAt: string } {
    return this.command(input.idempotencyKey, "run.cancel.request", () => {
      if (!input.actor.startsWith("human:")) {
        throw new Error("RUN_CANCELLATION_REQUIRES_HUMAN");
      }
      const current = this.get(input.id);
      if (current.status !== "in_progress") {
        throw new Error("Only in-progress work can request cancellation.");
      }
      const run = this.database
        .prepare(`
          SELECT id, cancel_requested_at
          FROM runs
          WHERE work_item_id = ? AND status IN ('running', 'waiting')
          ORDER BY generation DESC
          LIMIT 1
        `)
        .get(input.id) as Row | undefined;
      if (!run) throw new Error("No active run exists.");
      const requestedAt = run.cancel_requested_at
        ? String(run.cancel_requested_at)
        : now();
      this.database
        .prepare(`
          UPDATE runs
          SET cancel_requested_at = COALESCE(cancel_requested_at, ?),
              cancel_requested_by = COALESCE(cancel_requested_by, ?)
          WHERE id = ?
        `)
        .run(requestedAt, input.actor, String(run.id));
      this.event("run.cancel.requested", input.id, input.actor, {
        runId: String(run.id),
      });
      return {
        workItemId: input.id,
        runId: String(run.id),
        requestedAt,
      };
    });
  }

  isRunCancellationRequested(runId: string): boolean {
    const row = this.database
      .prepare(`
        SELECT cancel_requested_at
        FROM runs
        WHERE id = ? AND status IN ('running', 'waiting')
      `)
      .get(runId) as Row | undefined;
    return Boolean(row?.cancel_requested_at);
  }

  cancelRun(input: {
    id: string;
    generation: number;
    actor: string;
    idempotencyKey: string;
  }): WorkItem {
    return this.command(input.idempotencyKey, "run.cancel", () => {
      const current = this.get(input.id);
      if (current.status !== "in_progress") {
        throw new Error("Only in-progress work can cancel an active run.");
      }
      this.assertActiveGeneration(input.id, input.generation);
      const run = this.database
        .prepare(`
          SELECT id
          FROM runs
          WHERE work_item_id = ? AND generation = ?
            AND status IN ('running', 'waiting')
        `)
        .get(input.id, input.generation) as Row | undefined;
      if (!run) throw new Error("Active run was not found.");
      const stamp = now();
      this.database
        .prepare(`
          UPDATE model_invocations
          SET status = 'canceled', finished_at = ?
          WHERE status = 'running'
            AND attempt_id IN (
              SELECT id FROM attempts WHERE run_id = ?
            )
        `)
        .run(stamp, String(run.id));
      this.database
        .prepare(`
          UPDATE attempts
          SET status = 'canceled', finished_at = ?,
              error_code = 'RUN_CANCELED',
              error_message = 'The run was canceled by a human request.'
          WHERE run_id = ? AND status IN ('running', 'waiting')
        `)
        .run(stamp, String(run.id));
      this.database
        .prepare(`
          UPDATE runs SET status = 'canceled', finished_at = ?
          WHERE id = ?
        `)
        .run(stamp, String(run.id));
      this.database
        .prepare(`
          UPDATE leases SET released_at = ?
          WHERE run_id = ? AND released_at IS NULL
        `)
        .run(stamp, String(run.id));
      this.database
        .prepare(`
          UPDATE work_items
          SET status = 'canceled', availability = 'completed',
              next_action = 'No action required.',
              version = version + 1, updated_at = ?
          WHERE id = ?
        `)
        .run(stamp, input.id);
      this.event("run.canceled", input.id, input.actor, {
        runId: String(run.id),
        generation: input.generation,
        status: "canceled",
      });
      return this.get(input.id);
    });
  }

  heartbeat(input: {
    leaseId: string;
    generation: number;
    actor: string;
    idempotencyKey: string;
    leaseMinutes?: number;
  }): { leaseId: string; expiresAt: string } {
    return this.command(input.idempotencyKey, "lease.heartbeat", () => {
      const lease = this.database
        .prepare(`
          SELECT id, generation, expires_at, released_at
          FROM leases WHERE id = ?
        `)
        .get(input.leaseId) as Row | undefined;
      if (!lease || lease.released_at) {
        throw new Error("Lease is not active.");
      }
      if (Number(lease.generation) !== input.generation) {
        throw new Error("Lease generation does not match.");
      }
      if (Date.parse(String(lease.expires_at)) <= Date.now()) {
        throw new Error("Lease has expired.");
      }
      const stamp = now();
      const expiresAt = new Date(
        Date.now() + (input.leaseMinutes ?? 15) * 60_000,
      ).toISOString();
      this.database
        .prepare(`
          UPDATE leases SET heartbeat_at = ?, expires_at = ?
          WHERE id = ? AND released_at IS NULL
        `)
        .run(stamp, expiresAt, input.leaseId);
      this.event("lease.heartbeat", null, input.actor, {
        leaseId: input.leaseId,
        generation: input.generation,
        expiresAt,
      });
      return { leaseId: input.leaseId, expiresAt };
    });
  }

  failRun(input: {
    id: string;
    generation: number;
    attemptId: string;
    errorCode: string;
    errorMessage: string;
    actor: string;
    idempotencyKey: string;
  }): WorkItem {
    return this.command(input.idempotencyKey, "run.fail", () => {
      const current = this.get(input.id);
      if (current.status !== "in_progress") {
        throw new Error("Only in-progress work can fail an active run.");
      }
      this.assertActiveGeneration(input.id, input.generation);
      const message = assertText(input.errorMessage, "errorMessage").slice(
        0,
        1_000,
      );
      const code = assertText(input.errorCode, "errorCode").slice(0, 100);
      const stamp = now();
      const run = this.database
        .prepare(`
          SELECT id FROM runs
          WHERE work_item_id = ? AND generation = ? AND status = 'running'
        `)
        .get(input.id, input.generation) as Row | undefined;
      if (!run) throw new Error("Active run was not found.");
      this.database
        .prepare(`
          UPDATE attempts
          SET status = 'failed', finished_at = ?,
              error_code = ?, error_message = ?
          WHERE id = ? AND run_id = ? AND status = 'running'
        `)
        .run(stamp, code, message, input.attemptId, String(run.id));
      this.database
        .prepare(`
          UPDATE runs SET status = 'failed', finished_at = ?
          WHERE id = ?
        `)
        .run(stamp, String(run.id));
      this.database
        .prepare(`
          UPDATE leases SET released_at = ?
          WHERE run_id = ? AND released_at IS NULL
        `)
        .run(stamp, String(run.id));
      const unknownOutcomes = this.database
        .prepare(`
          UPDATE tool_evidence_receipts
          SET status = 'outcome_unknown', consumed_at = ?
          WHERE run_id = ? AND status = 'issued'
        `)
        .run(stamp, String(run.id));
      this.database
        .prepare(`
          UPDATE work_items
          SET status = 'failed', availability = 'ready',
              next_action = ?,
              version = version + 1, updated_at = ?
          WHERE id = ?
        `)
        .run(
          Number(unknownOutcomes.changes) > 0
            ? "A tool outcome is unknown. Inspect the workspace and explicitly acknowledge it before retrying."
            : "Inspect the failure and retry.",
          stamp,
          input.id,
        );
      this.event("run.failed", input.id, input.actor, {
        runId: String(run.id),
        attemptId: input.attemptId,
        generation: input.generation,
        errorCode: code,
        unknownToolOutcomes: Number(unknownOutcomes.changes),
      });
      return this.get(input.id);
    });
  }

  retry(input: {
    id: string;
    actor: string;
    idempotencyKey: string;
    acknowledgeUnknownToolOutcome?: boolean;
  }): WorkItem {
    return this.command(input.idempotencyKey, "run.retry", () => {
      const current = this.get(input.id);
      if (current.status !== "failed") {
        throw new Error("Only failed work can be retried.");
      }
      const unknownOutcomes = Number(
        (
          this.database
            .prepare(`
              SELECT COUNT(*) AS count
              FROM tool_evidence_receipts
              WHERE work_item_id = ? AND status = 'outcome_unknown'
            `)
            .get(input.id) as Row
        ).count,
      );
      if (unknownOutcomes > 0) {
        if (
          !input.actor.startsWith("human:") ||
          input.acknowledgeUnknownToolOutcome !== true
        ) {
          throw new Error(
            "TOOL_OUTCOME_UNKNOWN: inspect the workspace and retry with explicit human acknowledgement.",
          );
        }
        this.database
          .prepare(`
            UPDATE tool_evidence_receipts
            SET status = 'outcome_acknowledged'
            WHERE work_item_id = ? AND status = 'outcome_unknown'
          `)
          .run(input.id);
      }
      const stamp = now();
      this.database
        .prepare(`
          UPDATE work_items
          SET status = 'ready', availability = 'ready',
              wait_type = NULL, wait_reason = NULL, wait_reference = NULL,
              resume_at = NULL, wait_created_by = NULL,
              next_action = 'Claim and retry work.',
              version = version + 1, updated_at = ?
          WHERE id = ?
        `)
        .run(stamp, input.id);
      this.event("run.retry.requested", input.id, input.actor, {
        acknowledgedUnknownToolOutcomes: unknownOutcomes,
      });
      return this.get(input.id);
    });
  }

  recoverExpiredLeases(actor = "system:recovery"): string[] {
    return this.transact(() => {
      const expired = this.database
        .prepare(`
          SELECT l.id AS lease_id, l.run_id, l.attempt_id, l.generation,
                 r.work_item_id
          FROM leases l
          JOIN runs r ON r.id = l.run_id
          WHERE l.released_at IS NULL
            AND l.expires_at <= ?
            AND r.status = 'running'
          ORDER BY l.id
        `)
        .all(now()) as Row[];
      const recovered: string[] = [];
      for (const row of expired) {
        const stamp = now();
        const workItemId = String(row.work_item_id);
        const runningInvocations = this.database
          .prepare(`
            SELECT id
            FROM model_invocations
            WHERE attempt_id IN (
              SELECT id FROM attempts WHERE run_id = ?
            ) AND status = 'running'
            ORDER BY id
          `)
          .all(String(row.run_id)) as Row[];
        this.database
          .prepare(`
            UPDATE attempts
            SET status = 'failed', finished_at = ?,
                error_code = 'LEASE_EXPIRED',
                error_message = 'The worker lease expired before completion.'
            WHERE run_id = ? AND status = 'running'
          `)
          .run(stamp, String(row.run_id));
        this.database
          .prepare(`
            UPDATE model_invocations
            SET status = 'abandoned', finished_at = ?
            WHERE attempt_id IN (
              SELECT id FROM attempts WHERE run_id = ?
            ) AND status = 'running'
          `)
          .run(stamp, String(row.run_id));
        this.database
          .prepare(`
            UPDATE runs SET status = 'failed', finished_at = ?
            WHERE id = ? AND status = 'running'
          `)
          .run(stamp, String(row.run_id));
        this.database
          .prepare(`
            UPDATE leases SET released_at = ?
            WHERE id = ? AND released_at IS NULL
          `)
          .run(stamp, String(row.lease_id));
        const unknownOutcomes = this.database
          .prepare(`
            UPDATE tool_evidence_receipts
            SET status = 'outcome_unknown', consumed_at = ?
            WHERE run_id = ? AND status = 'issued'
          `)
          .run(stamp, String(row.run_id));
        this.database
          .prepare(`
            UPDATE work_items
            SET status = 'failed', availability = 'ready',
                next_action = ?,
                version = version + 1, updated_at = ?
            WHERE id = ? AND status = 'in_progress'
          `)
          .run(
            Number(unknownOutcomes.changes) > 0
              ? "The lease expired with an unknown tool outcome. Inspect and explicitly acknowledge it before retrying."
              : "The previous lease expired. Inspect and retry.",
            stamp,
            workItemId,
          );
        this.event("lease.expired", workItemId, actor, {
          leaseId: String(row.lease_id),
          runId: String(row.run_id),
          generation: Number(row.generation),
          unknownToolOutcomes: Number(unknownOutcomes.changes),
        });
        for (const invocation of runningInvocations) {
          this.event("model.invocation.abandoned", workItemId, actor, {
            invocationId: String(invocation.id),
            status: "abandoned",
            measurementStatus: "unknown",
          });
        }
        recovered.push(workItemId);
      }
      return recovered;
    });
  }

  progress(input: {
    id: string;
    summary: string;
    nextAction: string;
    actor: string;
    idempotencyKey: string;
  }): WorkItem {
    return this.command(input.idempotencyKey, "work.progress", () => {
      const current = this.get(input.id);
      if (current.status !== "in_progress") {
        throw new Error("Only in-progress work accepts progress.");
      }
      this.database
        .prepare(`
          UPDATE work_items
          SET next_action = ?, version = version + 1, updated_at = ?
          WHERE id = ?
        `)
        .run(assertText(input.nextAction, "nextAction"), now(), input.id);
      this.event("work.progressed", input.id, input.actor, {
        summary: assertText(input.summary, "summary"),
        nextAction: input.nextAction,
      });
      return this.get(input.id);
    });
  }

  wait(input: {
    id: string;
    condition: Omit<WaitCondition, "createdBy">;
    actor: string;
    idempotencyKey: string;
  }): WorkItem {
    return this.command(input.idempotencyKey, "work.wait", () => {
      const current = this.get(input.id);
      if (["done", "canceled"].includes(current.status)) {
        throw new Error("Terminal work cannot wait.");
      }
      const reason = assertText(input.condition.reason, "wait reason");
      if (
        input.condition.type === "not_before" &&
        !input.condition.resumeAt
      ) {
        throw new Error("not_before requires resumeAt.");
      }
      const availability = {
        predecessor: "dependency_waiting",
        not_before: "not_before",
        user_input: "user_input_waiting",
        manual_resume: "manual_resume",
        approval: "approval_waiting",
      }[input.condition.type];
      this.database
        .prepare(`
          UPDATE work_items
          SET availability = ?, wait_type = ?, wait_reason = ?,
              wait_reference = ?, resume_at = ?, wait_created_by = ?,
              next_action = ?, version = version + 1, updated_at = ?
          WHERE id = ?
        `)
        .run(
          availability,
          input.condition.type,
          reason,
          input.condition.reference ?? null,
          input.condition.resumeAt ?? null,
          input.actor,
          reason,
          now(),
          input.id,
        );
      this.database
        .prepare(`
          UPDATE leases SET released_at = ?
          WHERE run_id IN (
            SELECT id FROM runs WHERE work_item_id = ? AND status = 'running'
          ) AND released_at IS NULL
        `)
        .run(now(), input.id);
      this.database
        .prepare(`
          UPDATE runs SET status = 'waiting'
          WHERE work_item_id = ? AND status = 'running'
        `)
        .run(input.id);
      this.event("work.waiting", input.id, input.actor, {
        condition: input.condition,
      });
      return this.get(input.id);
    });
  }

  resume(input: {
    id: string;
    actor: string;
    idempotencyKey: string;
  }): WorkItem {
    return this.command(input.idempotencyKey, "work.resume", () => {
      const current = this.get(input.id);
      if (current.wait?.type === "user_input") {
        throw new Error(
          "User-input waits require a hash-bound provideUserInput command.",
        );
      }
      if (
        current.wait?.type === "approval" ||
        ["review_pending", "approved", "done", "canceled", "failed"].includes(
          current.status,
        )
      ) {
        throw new Error("Approval and terminal states require their dedicated command.");
      }
      if (current.availability === "dependency_waiting") {
        const blocked = this.blockingPredecessors(input.id);
        if (blocked.length > 0) {
          throw new Error(`Still blocked by: ${blocked.join(", ")}`);
        }
      }
      if (
        current.wait?.type === "not_before" &&
        current.wait.resumeAt &&
        Date.parse(current.wait.resumeAt) > Date.now()
      ) {
        throw new Error("The not-before time has not arrived.");
      }
      const status: WorkStatus =
        current.status === "requested" ? "requested" : "ready";
      this.database
        .prepare(`
          UPDATE work_items
          SET status = ?, availability = 'ready',
              wait_type = NULL, wait_reason = NULL, wait_reference = NULL,
              resume_at = NULL, wait_created_by = NULL,
              next_action = ?, version = version + 1,
              updated_at = ?
          WHERE id = ?
        `)
        .run(
          status,
          status === "requested"
            ? "Assign a role and execution target."
            : "Claim and resume work.",
          now(),
          input.id,
        );
      this.event("work.resumed", input.id, input.actor);
      return this.get(input.id);
    });
  }

  submitArtifact(input: {
    id: string;
    content: string;
    mediaType?: string;
    producerReport?: ArtifactProducerReport;
    generation: number;
    actor: string;
    idempotencyKey: string;
  }): {
    workItem: WorkItem;
    artifactId: string;
    sha256: string;
    producerReportHash: string | null;
  } {
    const result = this.command(input.idempotencyKey, "artifact.submit", () => {
      const current = this.get(input.id);
      if (current.status !== "in_progress") {
        throw new Error("Only in-progress work can submit an artifact.");
      }
      this.assertActiveGeneration(input.id, input.generation);
      const content = input.content;
      if (!content.trim()) throw new Error("artifact content is required.");
      const mediaType = (input.mediaType ?? "text/plain").trim();
      if (
        !mediaType ||
        mediaType.length > 256 ||
        mediaType.includes("\0") ||
        /[\r\n]/u.test(mediaType)
      ) {
        throw new Error("ARTIFACT_MEDIA_TYPE_INVALID");
      }
      const producerReport = input.producerReport
        ? normalizeArtifactProducerReport(input.producerReport)
        : (parseLegacyArtifactProducerReport(content) ?? undefined);
      const producerReportJson = producerReport
        ? JSON.stringify(producerReport)
        : null;
      const producerReportHash = producerReport
        ? canonicalHash(producerReport)
        : null;
      const producerReportByteSize = producerReportJson
        ? Buffer.byteLength(producerReportJson)
        : 0;
      const byteSize = Buffer.byteLength(content);
      const maxArtifactBytes =
        this.budgets?.maxArtifactBytes ?? DEFAULT_MAX_ARTIFACT_BYTES;
      if (byteSize + producerReportByteSize > maxArtifactBytes) {
        throw new Error("ARTIFACT_SIZE_LIMIT_EXCEEDED");
      }
      const priorBytes = this.database
        .prepare(
          `SELECT COALESCE(SUM(byte_size + producer_report_byte_size), 0) AS bytes
           FROM artifacts WHERE work_item_id = ?`,
        )
        .get(input.id) as Row;
      const maxWorkItemArtifactBytes =
        this.budgets?.maxWorkItemArtifactBytes ??
        DEFAULT_MAX_WORK_ITEM_ARTIFACT_BYTES;
      if (
        Number(priorBytes.bytes) + byteSize + producerReportByteSize >
        maxWorkItemArtifactBytes
      ) {
        throw new Error("WORK_ITEM_ARTIFACT_BUDGET_EXCEEDED");
      }
      const run = this.database
        .prepare(`
          SELECT id FROM runs
          WHERE work_item_id = ? AND status = 'running'
          ORDER BY generation DESC LIMIT 1
        `)
        .get(input.id) as Row | undefined;
      if (!run) throw new Error("No active run exists.");
      const digest = createHash("sha256").update(content).digest("hex");
      const storageName = `${digest}.txt`;
      const artifactPath = join(this.artifactDirectory, storageName);
      if (!existsSync(artifactPath)) {
        writeFileSync(artifactPath, content, {
          encoding: "utf8",
          flag: "wx",
        });
      }
      const artifactId = this.nextId("artifact");
      this.database
        .prepare(`
          INSERT INTO artifacts(
            id, work_item_id, run_id, sha256, storage_name,
            media_type, byte_size, producer_report_json,
            producer_report_hash, producer_report_byte_size, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          artifactId,
          input.id,
          String(run.id),
          digest,
          storageName,
          mediaType,
          byteSize,
          producerReportJson,
          producerReportHash,
          producerReportByteSize,
          now(),
        );
      const completedAt = now();
      this.database
        .prepare(`
          UPDATE attempts
          SET status = 'succeeded', finished_at = ?
          WHERE run_id = ? AND status IN ('running', 'waiting')
        `)
        .run(completedAt, String(run.id));
      this.database
        .prepare(`
          UPDATE runs
          SET status = 'succeeded', finished_at = ?
          WHERE id = ? AND status = 'running'
        `)
        .run(completedAt, String(run.id));
      this.database
        .prepare(`
          UPDATE leases SET released_at = ?
          WHERE run_id = ? AND released_at IS NULL
        `)
        .run(completedAt, String(run.id));
      this.database
        .prepare(`
          UPDATE work_items
          SET status = 'review_pending', availability = 'approval_waiting',
              wait_type = 'approval', wait_reason = 'Human review required.',
              wait_reference = ?, wait_created_by = ?,
              next_action = 'Review the submitted artifact.',
              version = version + 1, updated_at = ?
          WHERE id = ?
        `)
        .run(digest, input.actor, completedAt, input.id);
      const reviewItem = this.get(input.id);
      const packet = buildDecisionPacket({
        workItem: reviewItem,
        contract: this.decisionContract(input.id),
        subject: {
          kind: "artifact",
          artifactId,
          artifactHash: digest,
          mediaType,
        },
        artifactContent: content,
        ...(producerReport ? { producerReport } : {}),
        toolEvidence: this.listToolEvidence(input.id).filter(
          ({ runId }) => runId === String(run.id),
        ),
        createdAt: completedAt,
      });
      this.replaceDecisionPacket(packet, completedAt);
      this.event("artifact.submitted", input.id, input.actor, {
        artifactId,
        sha256: digest,
        producerReportHash,
        packetHash: packet.binding.packetHash,
      });
      return {
        workItem: this.get(input.id),
        artifactId,
        sha256: digest,
        producerReportHash,
      };
    });
    return {
      ...result,
      producerReportHash: result.producerReportHash ?? null,
    };
  }

  decide(input: {
    id: string;
    decision: "approve" | "changes_requested" | "reject";
    artifactHash: string;
    packetHash: string;
    note: string;
    actor: string;
    idempotencyKey: string;
    activeReviewMs?: number;
    detailsOpenCount?: number;
    completeOnApprove?: boolean;
  }): WorkItem {
    return this.command(input.idempotencyKey, "approval.decide", () => {
      const current = this.get(input.id);
      if (!input.actor.startsWith("human:")) {
        throw new Error("Artifact approval authority must be a human actor.");
      }
      if (current.status !== "review_pending") {
        throw new Error("Work is not waiting for review.");
      }
      if (input.completeOnApprove && input.decision !== "approve") {
        throw new Error("completeOnApprove is valid only for approval.");
      }
      const artifact = this.database
        .prepare(`
          SELECT sha256 FROM artifacts
          WHERE work_item_id = ?
          ORDER BY created_at DESC LIMIT 1
        `)
        .get(input.id) as Row | undefined;
      if (!artifact) throw new Error("Review requires an artifact.");
      if (String(artifact.sha256) !== input.artifactHash) {
        throw new Error("Review hash does not match the current artifact.");
      }
      const packet = this.decisionPacket(input.id);
      if (
        !packet ||
        packet.kind !== "artifact_review" ||
        packet.subject.kind !== "artifact" ||
        packet.subject.artifactHash !== input.artifactHash ||
        packet.binding.packetHash !== input.packetHash
      ) {
        throw new Error("Review packet does not match the current decision context.");
      }
      const activeReviewMs = optionalBoundedInteger(
        input.activeReviewMs,
        "activeReviewMs",
        86_400_000,
      );
      const detailsOpenCount = optionalBoundedInteger(
        input.detailsOpenCount,
        "detailsOpenCount",
        10_000,
      );
      const approvalId = this.nextId("approval");
      const decidedAt = now();
      this.ensureDecisionPacketStored(packet, decidedAt);
      this.database
        .prepare(`
          INSERT INTO approvals(
            id, work_item_id, artifact_hash, decision, note, actor, created_at,
            packet_hash
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          approvalId,
          input.id,
          String(artifact.sha256),
          input.decision,
          assertText(input.note, "decision note"),
          input.actor,
          decidedAt,
          input.packetHash,
        );
      const nextStatus =
        input.decision === "approve"
          ? "approved"
          : input.decision === "changes_requested"
            ? "changes_requested"
            : "canceled";
      const availability =
        input.decision === "reject" ? "completed" : "ready";
      const nextAction =
        input.decision === "approve"
          ? "Complete the work or request separate execution approval."
          : input.decision === "changes_requested"
            ? "Claim a new run and address review feedback."
            : "No further action.";
      this.database
        .prepare(`
          UPDATE work_items
          SET status = ?, availability = ?,
              wait_type = NULL, wait_reason = NULL, wait_reference = NULL,
              wait_created_by = NULL, next_action = ?,
              version = version + 1, updated_at = ?
          WHERE id = ?
        `)
        .run(nextStatus, availability, nextAction, decidedAt, input.id);
      this.database
        .prepare(`
          UPDATE runs SET status = ?, finished_at = ?
          WHERE work_item_id = ? AND status IN ('running', 'waiting')
        `)
        .run(
          input.decision === "approve" ? "succeeded" : nextStatus,
          decidedAt,
          input.id,
        );
      this.database
        .prepare(`
          UPDATE leases SET released_at = ?
          WHERE run_id IN (SELECT id FROM runs WHERE work_item_id = ?)
            AND released_at IS NULL
        `)
        .run(decidedAt, input.id);
      this.event("approval.decided", input.id, input.actor, {
        approvalId,
        decision: input.decision,
        artifactHash: artifact.sha256,
        packetHash: input.packetHash,
        ...(activeReviewMs === undefined
          ? {}
          : {
              activeReviewMs,
              reviewMeasurementStatus: "estimated",
            }),
        ...(detailsOpenCount === undefined ? {} : { detailsOpenCount }),
      });
      if (input.completeOnApprove) {
        this.completeApprovedWork(input.id, input.actor, decidedAt);
      }
      return this.get(input.id);
    });
  }

  latestArtifactDecision(id: string): ArtifactReviewDecision | null {
    this.get(id);
    const row = this.database
      .prepare(`
        SELECT id, work_item_id, artifact_hash, decision, note, actor,
               created_at, packet_hash
        FROM approvals
        WHERE work_item_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      `)
      .get(id) as Row | undefined;
    if (!row) return null;
    return {
      id: String(row.id),
      workItemId: String(row.work_item_id),
      artifactHash: String(row.artifact_hash),
      decision: String(row.decision) as ArtifactReviewDecision["decision"],
      note: String(row.note),
      packetHash: row.packet_hash ? String(row.packet_hash) : null,
      actor: String(row.actor),
      createdAt: String(row.created_at),
    };
  }

  private completeApprovedWork(
    id: string,
    actor: string,
    completedAt: string,
  ): string[] {
    const current = this.get(id);
    if (current.status !== "approved") {
      throw new Error("Only approved work can complete.");
    }
    this.database
      .prepare(`
        UPDATE work_items
        SET status = 'done', availability = 'completed',
            next_action = 'Completed.', version = version + 1, updated_at = ?
        WHERE id = ?
      `)
      .run(completedAt, id);
    this.event("work.completed", id, actor);

    const successorRows = this.database
      .prepare(`
        SELECT work_item_id
        FROM dependencies
        WHERE predecessor_id = ? AND active = 1
      `)
      .all(id) as Row[];
    const resurfaced: string[] = [];
    for (const row of successorRows) {
      const successorId = String(row.work_item_id);
      if (this.blockingPredecessors(successorId).length === 0) {
        const update = this.database
          .prepare(`
            UPDATE work_items
            SET availability = 'ready',
                wait_type = NULL, wait_reason = NULL, wait_reference = NULL,
                wait_created_by = NULL,
                next_action = 'Predecessors complete. Claim work.',
                version = version + 1, updated_at = ?
            WHERE id = ? AND availability = 'dependency_waiting'
          `)
          .run(completedAt, successorId);
        if (Number(update.changes) > 0) {
          resurfaced.push(successorId);
          this.event("work.resurfaced", successorId, actor, {
            completedPredecessor: id,
          });
        }
      }
    }
    return resurfaced;
  }

  complete(input: {
    id: string;
    actor: string;
    idempotencyKey: string;
  }): { workItem: WorkItem; resurfaced: string[] } {
    return this.command(input.idempotencyKey, "work.complete", () => {
      const resurfaced = this.completeApprovedWork(
        input.id,
        input.actor,
        now(),
      );
      return { workItem: this.get(input.id), resurfaced };
    });
  }

  archive(input: {
    id: string;
    actor: string;
    idempotencyKey: string;
  }): WorkItem {
    return this.command(input.idempotencyKey, "work.archive", () => {
      if (!input.actor.startsWith("human:")) {
        throw new Error("WORK_ARCHIVE_REQUIRES_HUMAN");
      }
      const current = this.get(input.id);
      if (!["done", "canceled"].includes(current.status)) {
        throw new Error("Only completed or canceled work can be archived.");
      }
      if (!current.archivedAt) {
        this.database
          .prepare(`
            UPDATE work_items
            SET archived_at = ?, version = version + 1, updated_at = ?
            WHERE id = ?
          `)
          .run(now(), now(), input.id);
        this.event("work.archived", input.id, input.actor);
      }
      return this.get(input.id);
    });
  }

  startInvocation(input: {
    attemptId: string;
    engineId: string;
    modelId: string;
  }): ModelInvocationRecord {
    return this.transact(() => {
      this.assertModelStartBudget();
      const attempt = this.database
        .prepare(`
          SELECT a.id, r.work_item_id
          FROM attempts a
          JOIN runs r ON r.id = a.run_id
          WHERE a.id = ? AND a.status = 'running'
        `)
        .get(input.attemptId) as Row | undefined;
      if (!attempt) throw new Error("Invocation attempt is not active.");
      const id = this.nextId("invocation");
      const stamp = now();
      this.database
        .prepare(`
          INSERT INTO model_invocations(
            id, attempt_id, engine_id, model_id, status, input_tokens,
            output_tokens, cost, measurement_status, started_at, finished_at
          ) VALUES (?, ?, ?, ?, 'running', NULL, NULL, NULL, 'unknown', ?, NULL)
        `)
        .run(
          id,
          input.attemptId,
          assertText(input.engineId, "engineId"),
          assertText(input.modelId, "modelId"),
          stamp,
        );
      this.event(
        "model.invocation.started",
        String(attempt.work_item_id),
        "runner:local",
        {
          invocationId: id,
          engineId: input.engineId,
          modelId: input.modelId,
        },
      );
      return asInvocation(
        this.database
          .prepare("SELECT * FROM model_invocations WHERE id = ?")
          .get(id) as Row,
      );
    });
  }

  finishInvocation(input: {
    id: string;
    status: "succeeded" | "failed" | "canceled";
    inputTokens: number | null;
    outputTokens: number | null;
    cost: number | null;
    measurementStatus: "measured" | "estimated" | "unknown";
  }): ModelInvocationRecord {
    return this.transact(() => {
      for (const [label, value] of [
        ["inputTokens", input.inputTokens],
        ["outputTokens", input.outputTokens],
      ] as const) {
        if (
          value !== null &&
          (!Number.isInteger(value) || value < 0)
        ) {
          throw new Error(`${label} must be a non-negative integer or null.`);
        }
      }
      if (
        input.cost !== null &&
        (!Number.isFinite(input.cost) || input.cost < 0)
      ) {
        throw new Error("cost must be a finite non-negative number or null.");
      }
      const stamp = now();
      const update = this.database
        .prepare(`
          UPDATE model_invocations
          SET status = ?, input_tokens = ?, output_tokens = ?, cost = ?,
              measurement_status = ?, finished_at = ?
          WHERE id = ? AND status = 'running'
        `)
        .run(
          input.status,
          input.inputTokens,
          input.outputTokens,
          input.cost,
          input.measurementStatus,
          stamp,
          input.id,
        );
      const row = this.database
        .prepare(`
          SELECT mi.*, r.work_item_id
          FROM model_invocations mi
          JOIN attempts a ON a.id = mi.attempt_id
          JOIN runs r ON r.id = a.run_id
          WHERE mi.id = ?
        `)
        .get(input.id) as Row | undefined;
      if (!row) throw new Error(`Unknown model invocation '${input.id}'.`);
      if (Number(update.changes) > 0) {
        this.event(
          `model.invocation.${input.status}`,
          String(row.work_item_id),
          "runner:local",
          {
            invocationId: input.id,
            status: input.status,
            measurementStatus: input.measurementStatus,
          },
        );
      }
      return asInvocation(row);
    });
  }

  recordInvocation(input: {
    attemptId: string;
    engineId: string;
    modelId: string;
    status: "succeeded" | "failed";
    inputTokens: number | null;
    outputTokens: number | null;
    cost: number | null;
    measurementStatus: "measured" | "estimated" | "unknown";
  }): string {
    const started = this.startInvocation(input);
    this.finishInvocation({
      id: started.id,
      status: input.status,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      cost: input.cost,
      measurementStatus: input.measurementStatus,
    });
    return started.id;
  }

  listInvocations(attemptId?: string): ModelInvocationRecord[] {
    const rows = attemptId
      ? (this.database
          .prepare(`
            SELECT * FROM model_invocations
            WHERE attempt_id = ?
            ORDER BY started_at, id
          `)
          .all(attemptId) as Row[])
      : (this.database
          .prepare(`
            SELECT * FROM model_invocations
            ORDER BY started_at, id
          `)
          .all() as Row[]);
    return rows.map(asInvocation);
  }

  recordPendingToolCall(input: {
    id: string;
    runId: string;
    attemptId: string;
    callHash: string;
    toolName: string;
    arguments: unknown;
    createdAt: string;
    actor: string;
  }): PendingToolCall {
    return this.command(
      `pending-tool:${input.id}:${input.callHash}`,
      "tool.pending.record",
      () => {
        const current = this.get(input.id);
        if (current.status !== "in_progress") {
          throw new Error(
            "Only in-progress work can wait for tool approval.",
          );
        }
        if (!/^[a-f0-9]{64}$/u.test(input.callHash)) {
          throw new Error("callHash must be a SHA-256 digest.");
        }
        const argumentsJson = JSON.stringify(input.arguments);
        if (
          argumentsJson === undefined ||
          Buffer.byteLength(argumentsJson, "utf8") > 300_000
        ) {
          throw new Error(
            "Pending tool arguments must be JSON of at most 300000 bytes.",
          );
        }
        const parsedArguments = JSON.parse(argumentsJson) as unknown;
        if (
          parsedArguments &&
          typeof parsedArguments === "object" &&
          !Array.isArray(parsedArguments) &&
          typeof (parsedArguments as Record<string, unknown>).unparsed ===
            "string"
        ) {
          throw new Error(
            "Pending tool arguments must be fully parsed before approval.",
          );
        }
        const pending: PendingToolCall = {
          id: `pending-tool-${randomUUID()}`,
          workItemId: input.id,
          runId: input.runId,
          attemptId: input.attemptId,
          callHash: input.callHash,
          toolName: assertText(input.toolName, "toolName"),
          arguments: parsedArguments,
          status: "approval_required",
          createdAt: input.createdAt,
          executedAt: null,
        };
        this.database
          .prepare(`
            INSERT INTO pending_tool_calls(
              id, work_item_id, run_id, attempt_id, call_hash, tool_name,
              arguments_json, status, created_at, executed_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
          `)
          .run(
            pending.id,
            pending.workItemId,
            pending.runId,
            pending.attemptId,
            pending.callHash,
            pending.toolName,
            argumentsJson,
            pending.status,
            pending.createdAt,
          );
        const stamp = now();
        const run = this.database
          .prepare(`
            SELECT id
            FROM runs
            WHERE id = ? AND work_item_id = ? AND status = 'running'
          `)
          .get(input.runId, input.id) as Row | undefined;
        if (!run) {
          throw new Error("Active run was not found for tool approval.");
        }
        const attempt = this.database
          .prepare(`
            SELECT id
            FROM attempts
            WHERE id = ? AND run_id = ? AND status = 'running'
          `)
          .get(input.attemptId, input.runId) as Row | undefined;
        if (!attempt) {
          throw new Error("Active attempt was not found for tool approval.");
        }
        const invocationRows = this.database
          .prepare(`
            SELECT id
            FROM model_invocations
            WHERE attempt_id = ? AND status = 'running'
          `)
          .all(input.attemptId) as Row[];
        this.database
          .prepare(`
            UPDATE model_invocations
            SET status = 'succeeded', measurement_status = 'unknown',
                finished_at = ?
            WHERE attempt_id = ? AND status = 'running'
          `)
          .run(stamp, input.attemptId);
        for (const invocation of invocationRows) {
          this.event(
            "model.invocation.succeeded",
            input.id,
            "runner:local",
            {
              invocationId: String(invocation.id),
              status: "succeeded",
              measurementStatus: "unknown",
            },
          );
        }
        this.database
          .prepare(`
            UPDATE attempts
            SET status = 'waiting'
            WHERE id = ? AND run_id = ? AND status = 'running'
          `)
          .run(input.attemptId, input.runId);
        this.database
          .prepare(`
            UPDATE runs
            SET status = 'waiting'
            WHERE id = ? AND work_item_id = ? AND status = 'running'
          `)
          .run(input.runId, input.id);
        this.database
          .prepare(`
            UPDATE leases
            SET released_at = ?
            WHERE run_id = ? AND attempt_id = ? AND released_at IS NULL
          `)
          .run(stamp, input.runId, input.attemptId);
        this.database
          .prepare(`
            UPDATE work_items
            SET availability = 'approval_waiting',
                wait_type = 'approval',
                wait_reason = 'Review the proposed tool change.',
                wait_reference = ?,
                wait_created_by = ?,
                next_action = 'Review the proposed tool change.',
                version = version + 1,
                updated_at = ?
            WHERE id = ?
          `)
          .run(input.callHash, input.actor, stamp, input.id);
        const approvalItem = this.get(input.id);
        const packet = buildDecisionPacket({
          workItem: approvalItem,
          contract: this.decisionContract(input.id),
          subject: {
            kind: "tool_call",
            callHash: pending.callHash,
            toolName: pending.toolName,
          },
          toolEvidence: this.listToolEvidence(input.id).filter(
            ({ runId }) => runId === input.runId,
          ),
          createdAt: stamp,
        });
        this.replaceDecisionPacket(packet, stamp);
        this.event("tool.approval.required", input.id, input.actor, {
          callHash: pending.callHash,
          toolName: pending.toolName,
          packetHash: packet.binding.packetHash,
        });
        return pending;
      },
    );
  }

  listPendingToolCalls(id: string): PendingToolCall[] {
    this.get(id);
    const rows = this.database
      .prepare(`
        SELECT *
        FROM pending_tool_calls
        WHERE work_item_id = ?
        ORDER BY created_at, id
      `)
      .all(id) as Row[];
    return rows.map((row) => ({
      id: String(row.id),
      workItemId: String(row.work_item_id),
      runId: String(row.run_id),
      attemptId: String(row.attempt_id),
      callHash: String(row.call_hash),
      toolName: String(row.tool_name),
      arguments: JSON.parse(String(row.arguments_json)) as unknown,
      status: String(row.status) as PendingToolCall["status"],
      createdAt: String(row.created_at),
      executedAt: row.executed_at ? String(row.executed_at) : null,
    }));
  }

  approvedPendingToolCall(id: string): PendingToolCall | null {
    this.get(id);
    const row = this.database
      .prepare(`
        SELECT p.*
        FROM pending_tool_calls p
        JOIN tool_approvals a
          ON a.work_item_id = p.work_item_id
         AND a.call_hash = p.call_hash
         AND a.tool_name = p.tool_name
        WHERE p.work_item_id = ?
          AND p.status = 'approval_required'
        ORDER BY p.created_at, p.id
        LIMIT 1
      `)
      .get(id) as Row | undefined;
    if (!row) return null;
    return {
      id: String(row.id),
      workItemId: String(row.work_item_id),
      runId: String(row.run_id),
      attemptId: String(row.attempt_id),
      callHash: String(row.call_hash),
      toolName: String(row.tool_name),
      arguments: JSON.parse(String(row.arguments_json)) as unknown,
      status: String(row.status) as PendingToolCall["status"],
      createdAt: String(row.created_at),
      executedAt: row.executed_at ? String(row.executed_at) : null,
    };
  }

  markPendingToolCallExecuted(input: {
    id: string;
    callHash: string;
    actor: string;
    idempotencyKey: string;
  }): PendingToolCall {
    return this.command(input.idempotencyKey, "tool.pending.executed", () => {
      const pending = this.listPendingToolCalls(input.id).find(
        ({ callHash }) => callHash === input.callHash,
      );
      if (!pending) throw new Error("Pending tool call does not exist.");
      if (pending.status !== "approval_required") {
        throw new Error("Pending tool call is not awaiting execution.");
      }
      const executedAt = now();
      this.database
        .prepare(`
          UPDATE pending_tool_calls
          SET status = 'executed', executed_at = ?
          WHERE work_item_id = ? AND call_hash = ?
        `)
        .run(executedAt, input.id, input.callHash);
      this.event("tool.pending.executed", input.id, input.actor, {
        callHash: pending.callHash,
        toolName: pending.toolName,
      });
      return {
        ...pending,
        status: "executed",
        executedAt,
      };
    });
  }

  approveToolCall(input: {
    id: string;
    callHash: string;
    toolName: string;
    packetHash: string;
    actor: string;
    note: string;
    idempotencyKey: string;
    activeReviewMs?: number;
    detailsOpenCount?: number;
  }): ToolCallApproval {
    return this.command(input.idempotencyKey, "tool.approve", () => {
      const current = this.get(input.id);
      if (!input.actor.startsWith("human:")) {
        throw new Error("Tool approval authority must be a human actor.");
      }
      if (!/^[a-f0-9]{64}$/u.test(input.callHash)) {
        throw new Error("callHash must be a SHA-256 digest.");
      }
      const toolName = assertText(input.toolName, "toolName");
      if (
        current.status !== "in_progress" ||
        current.availability !== "approval_waiting" ||
        current.wait?.type !== "approval" ||
        current.wait.reference !== input.callHash
      ) {
        throw new Error("Work is not actively waiting for this tool approval.");
      }
      const pending = this.database
        .prepare(`
          SELECT id
          FROM pending_tool_calls
          WHERE work_item_id = ? AND call_hash = ? AND tool_name = ?
            AND status = 'approval_required'
        `)
        .get(input.id, input.callHash, toolName) as Row | undefined;
      if (!pending) {
        throw new Error("Pending tool call does not exist.");
      }
      const packet = this.decisionPacket(input.id);
      if (
        !packet ||
        packet.kind !== "tool_execution" ||
        packet.subject.kind !== "tool_call" ||
        packet.subject.callHash !== input.callHash ||
        packet.subject.toolName !== toolName ||
        packet.binding.packetHash !== input.packetHash
      ) {
        throw new Error("Tool approval packet does not match the current decision context.");
      }
      const activeReviewMs = optionalBoundedInteger(
        input.activeReviewMs,
        "activeReviewMs",
        86_400_000,
      );
      const detailsOpenCount = optionalBoundedInteger(
        input.detailsOpenCount,
        "detailsOpenCount",
        10_000,
      );
      const approvalId = this.nextId("tool-approval");
      const createdAt = now();
      this.ensureDecisionPacketStored(packet, createdAt);
      this.database
        .prepare(`
          INSERT INTO tool_approvals(
            id, work_item_id, call_hash, tool_name, actor, note, created_at,
            packet_hash
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          approvalId,
          input.id,
          input.callHash,
          toolName,
          input.actor,
          assertText(input.note, "note"),
          createdAt,
          input.packetHash,
        );
      this.database
        .prepare(`
          UPDATE attempts
          SET status = 'succeeded', finished_at = ?
          WHERE id IN (
            SELECT attempt_id
            FROM pending_tool_calls
            WHERE work_item_id = ? AND call_hash = ?
          ) AND status = 'waiting'
        `)
        .run(createdAt, input.id, input.callHash);
      this.database
        .prepare(`
          UPDATE runs
          SET status = 'succeeded', finished_at = ?
          WHERE id IN (
            SELECT run_id
            FROM pending_tool_calls
            WHERE work_item_id = ? AND call_hash = ?
          ) AND status = 'waiting'
        `)
        .run(createdAt, input.id, input.callHash);
      this.database
        .prepare(`
          UPDATE work_items
          SET status = 'ready', availability = 'ready',
              wait_type = NULL, wait_reason = NULL, wait_reference = NULL,
              resume_at = NULL, wait_created_by = NULL,
              next_action = 'Run the exact approved tool call.',
              version = version + 1, updated_at = ?
          WHERE id = ?
        `)
        .run(createdAt, input.id);
      this.event("tool.approved", input.id, input.actor, {
        approvalId,
        callHash: input.callHash,
        toolName,
        packetHash: input.packetHash,
        ...(activeReviewMs === undefined
          ? {}
          : {
              activeReviewMs,
              reviewMeasurementStatus: "estimated",
            }),
        ...(detailsOpenCount === undefined ? {} : { detailsOpenCount }),
      });
      return {
        id: approvalId,
        workItemId: input.id,
        callHash: input.callHash,
        toolName,
        actor: input.actor,
        note: input.note.trim(),
        packetHash: input.packetHash,
        createdAt,
      };
    });
  }

  denyToolCall(input: {
    id: string;
    callHash: string;
    toolName: string;
    packetHash: string;
    actor: string;
    note: string;
    idempotencyKey: string;
    activeReviewMs?: number;
    detailsOpenCount?: number;
  }): ToolCallDenial {
    return this.command(input.idempotencyKey, "tool.deny", () => {
      const current = this.get(input.id);
      if (!input.actor.startsWith("human:")) {
        throw new Error("Tool denial authority must be a human actor.");
      }
      if (!/^[a-f0-9]{64}$/u.test(input.callHash)) {
        throw new Error("callHash must be a SHA-256 digest.");
      }
      const toolName = assertText(input.toolName, "toolName");
      if (
        current.status !== "in_progress" ||
        current.availability !== "approval_waiting" ||
        current.wait?.type !== "approval" ||
        current.wait.reference !== input.callHash
      ) {
        throw new Error("Work is not actively waiting for this tool decision.");
      }
      const pending = this.database
        .prepare(`
          SELECT id, run_id, attempt_id
          FROM pending_tool_calls
          WHERE work_item_id = ? AND call_hash = ? AND tool_name = ?
            AND status = 'approval_required'
        `)
        .get(input.id, input.callHash, toolName) as Row | undefined;
      if (!pending) {
        throw new Error("Pending tool call does not exist.");
      }
      const packet = this.decisionPacket(input.id);
      if (
        !packet ||
        packet.kind !== "tool_execution" ||
        packet.subject.kind !== "tool_call" ||
        packet.subject.callHash !== input.callHash ||
        packet.subject.toolName !== toolName ||
        packet.binding.packetHash !== input.packetHash
      ) {
        throw new Error("Tool denial packet does not match the current decision context.");
      }
      const activeReviewMs = optionalBoundedInteger(
        input.activeReviewMs,
        "activeReviewMs",
        86_400_000,
      );
      const detailsOpenCount = optionalBoundedInteger(
        input.detailsOpenCount,
        "detailsOpenCount",
        10_000,
      );
      const denialId = this.nextId("tool-denial");
      const deniedAt = now();
      this.ensureDecisionPacketStored(packet, deniedAt);
      const note = assertText(input.note, "note");
      this.database
        .prepare(`
          INSERT INTO tool_denials(
            id, work_item_id, call_hash, tool_name, actor, note,
            packet_hash, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          denialId,
          input.id,
          input.callHash,
          toolName,
          input.actor,
          note,
          input.packetHash,
          deniedAt,
        );
      this.database
        .prepare(`
          UPDATE pending_tool_calls
          SET status = 'denied', executed_at = ?
          WHERE id = ?
        `)
        .run(deniedAt, String(pending.id));
      this.database
        .prepare(`
          UPDATE attempts
          SET status = 'canceled', finished_at = ?,
              error_code = 'TOOL_CALL_DENIED',
              error_message = 'A human denied the exact pending tool call.'
          WHERE id = ? AND status = 'waiting'
        `)
        .run(deniedAt, String(pending.attempt_id));
      this.database
        .prepare(`
          UPDATE runs
          SET status = 'canceled', finished_at = ?
          WHERE id = ? AND status = 'waiting'
        `)
        .run(deniedAt, String(pending.run_id));
      this.database
        .prepare(`
          UPDATE work_items
          SET status = 'canceled', availability = 'completed',
              wait_type = NULL, wait_reason = NULL, wait_reference = NULL,
              resume_at = NULL, wait_created_by = NULL,
              next_action = 'No further action.',
              version = version + 1, updated_at = ?
          WHERE id = ?
        `)
        .run(deniedAt, input.id);
      this.database
        .prepare(`
          UPDATE decision_packets
          SET superseded_at = ?
          WHERE work_item_id = ? AND superseded_at IS NULL
        `)
        .run(deniedAt, input.id);
      this.event("tool.denied", input.id, input.actor, {
        denialId,
        callHash: input.callHash,
        toolName,
        packetHash: input.packetHash,
        ...(activeReviewMs === undefined
          ? {}
          : {
              activeReviewMs,
              reviewMeasurementStatus: "estimated",
            }),
        ...(detailsOpenCount === undefined ? {} : { detailsOpenCount }),
      });
      return {
        id: denialId,
        workItemId: input.id,
        callHash: input.callHash,
        toolName,
        actor: input.actor,
        note,
        packetHash: input.packetHash,
        createdAt: deniedAt,
      };
    });
  }

  isToolCallApproved(
    id: string,
    callHash: string,
    toolName: string,
  ): boolean {
    const row = this.database
      .prepare(`
        SELECT 1
        FROM tool_approvals
        WHERE work_item_id = ? AND call_hash = ? AND tool_name = ?
      `)
      .get(id, callHash, toolName);
    return Boolean(row);
  }

  prepareToolEvidence(input: {
    id: string;
    runId: string;
    attemptId: string;
    callHash: string;
    toolName: string;
    inputHash: string;
    actor: string;
  }): { id: string; token: string } {
    return this.transact(() => {
      const current = this.get(input.id);
      if (current.status !== "in_progress") {
        throw new Error(
          "Tool evidence preparation requires an active in-progress work item.",
        );
      }
      for (const hash of [input.callHash, input.inputHash]) {
        if (!/^[a-f0-9]{64}$/u.test(hash)) {
          throw new Error(
            "Tool evidence preparation contains an invalid SHA-256 digest.",
          );
        }
      }
      const toolName = assertText(input.toolName, "toolName");
      const actor = assertText(input.actor, "actor");
      const lineage = this.database
        .prepare(`
          SELECT runs.work_item_id, runs.status AS run_status,
                 attempts.status AS attempt_status
          FROM runs
          JOIN attempts ON attempts.run_id = runs.id
          WHERE runs.id = ? AND attempts.id = ?
        `)
        .get(input.runId, input.attemptId) as Row | undefined;
      if (
        !lineage ||
        String(lineage.work_item_id) !== input.id ||
        String(lineage.run_status) !== "running" ||
        String(lineage.attempt_status) !== "running"
      ) {
        throw new Error(
          "Tool evidence preparation must use the active run and attempt lineage.",
        );
      }
      const id = `tool-receipt-${randomUUID()}`;
      const token = randomBytes(32).toString("hex");
      const tokenHash = createHash("sha256").update(token).digest("hex");
      const issuedAt = now();
      this.database
        .prepare(`
          INSERT INTO tool_evidence_receipts(
            id, work_item_id, run_id, attempt_id, call_hash, tool_name,
            input_hash, token_hash, status, issued_at, consumed_at,
            evidence_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'issued', ?, NULL, NULL)
        `)
        .run(
          id,
          input.id,
          input.runId,
          input.attemptId,
          input.callHash,
          toolName,
          input.inputHash,
          tokenHash,
          issuedAt,
        );
      this.event("tool.evidence.prepared", input.id, actor, {
        receiptId: id,
        runId: input.runId,
        attemptId: input.attemptId,
        callHash: input.callHash,
        toolName,
      });
      return { id, token };
    });
  }

  recordToolEvidence(input: {
    receipt: ToolEvidenceReceipt;
    evidenceId: string;
    id: string;
    runId: string;
    attemptId: string;
    callHash: string;
    toolName: string;
    status: ToolExecutionEvidenceRecord["status"];
    inputHash: string;
    outputHash: string | null;
    paths: string[];
    durationMs: number;
    createdAt: string;
    actor: string;
  }): ToolExecutionEvidenceRecord {
    return this.command(
      `tool-evidence:${input.evidenceId}`,
      "tool.evidence.record",
      () => {
        const current = this.get(input.id);
        if (current.status !== "in_progress") {
          throw new Error("Tool evidence requires an active in-progress work item.");
        }
        const actor = assertText(input.actor, "actor");
        const lineage = this.database
          .prepare(`
            SELECT runs.work_item_id, runs.status AS run_status,
                   attempts.status AS attempt_status
            FROM runs
            JOIN attempts ON attempts.run_id = runs.id
            WHERE runs.id = ? AND attempts.id = ?
          `)
          .get(input.runId, input.attemptId) as Row | undefined;
        if (
          !lineage ||
          String(lineage.work_item_id) !== input.id ||
          String(lineage.run_status) !== "running" ||
          String(lineage.attempt_status) !== "running"
        ) {
          throw new Error(
            "Tool evidence run and attempt must be the active lineage of this work item.",
          );
        }
        for (const hash of [
          input.callHash,
          input.inputHash,
          ...(input.outputHash ? [input.outputHash] : []),
        ]) {
          if (!/^[a-f0-9]{64}$/u.test(hash)) {
            throw new Error("Tool evidence contains an invalid SHA-256 digest.");
          }
        }
        if (
          !["succeeded", "approval_required", "denied", "failed"].includes(
            input.status,
          )
        ) {
          throw new Error("Tool evidence status is invalid.");
        }
        if (!/^[a-f0-9]{64}$/u.test(input.receipt.token)) {
          throw new Error("Tool evidence receipt token is invalid.");
        }
        const receipt = this.database
          .prepare(`
            SELECT *
            FROM tool_evidence_receipts
            WHERE id = ? AND status = 'issued'
          `)
          .get(input.receipt.id) as Row | undefined;
        const receiptTokenHash = createHash("sha256")
          .update(input.receipt.token)
          .digest("hex");
        if (
          !receipt ||
          String(receipt.work_item_id) !== input.id ||
          String(receipt.run_id) !== input.runId ||
          String(receipt.attempt_id) !== input.attemptId ||
          String(receipt.call_hash) !== input.callHash ||
          String(receipt.tool_name) !== input.toolName ||
          String(receipt.input_hash) !== input.inputHash ||
          String(receipt.token_hash) !== receiptTokenHash
        ) {
          throw new Error(
            "Tool evidence does not match an unconsumed Tool Runtime receipt.",
          );
        }
        const record: ToolExecutionEvidenceRecord = {
          id: input.evidenceId,
          workItemId: input.id,
          runId: input.runId,
          attemptId: input.attemptId,
          receiptId: input.receipt.id,
          provenance: "control_plane_receipt",
          callHash: input.callHash,
          toolName: assertText(input.toolName, "toolName"),
          status: input.status,
          inputHash: input.inputHash,
          outputHash: input.outputHash,
          paths: input.paths.map((path) =>
            assertText(path, "evidence path").slice(0, 1_000)
          ),
          durationMs: Math.max(0, Math.floor(input.durationMs)),
          createdAt: input.createdAt,
        };
        const runtimeEvidence: ToolExecutionEvidence = {
          id: record.id,
          callHash: record.callHash,
          toolName: record.toolName,
          status: record.status,
          inputHash: record.inputHash,
          outputHash: record.outputHash,
          paths: record.paths,
          durationMs: record.durationMs,
          createdAt: record.createdAt,
        };
        if (!verifyToolRuntimeReceipt(input.id, runtimeEvidence, input.receipt)) {
          throw new Error(
            "Tool evidence was not issued by the in-process Tool Runtime.",
          );
        }
        this.database
          .prepare(`
            INSERT INTO tool_evidence(
              id, work_item_id, run_id, attempt_id, call_hash, tool_name,
              status, input_hash, output_hash, paths_json, duration_ms,
              created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `)
          .run(
            record.id,
            record.workItemId,
            record.runId,
            record.attemptId,
            record.callHash,
            record.toolName,
            record.status,
            record.inputHash,
            record.outputHash,
            JSON.stringify(record.paths),
            record.durationMs,
            record.createdAt,
          );
        const consumed = this.database
          .prepare(`
            UPDATE tool_evidence_receipts
            SET status = 'consumed', consumed_at = ?, evidence_id = ?
            WHERE id = ? AND status = 'issued'
          `)
          .run(now(), record.id, input.receipt.id);
        if (Number(consumed.changes) !== 1) {
          throw new Error("Tool evidence receipt was already consumed.");
        }
        this.event("tool.executed", input.id, actor, {
          evidenceId: record.id,
          receiptId: input.receipt.id,
          callHash: record.callHash,
          toolName: record.toolName,
          status: record.status,
          inputHash: record.inputHash,
          outputHash: record.outputHash,
        });
        return record;
      },
    );
  }

  listToolEvidence(id: string): ToolExecutionEvidenceRecord[] {
    this.get(id);
    const rows = this.database
      .prepare(`
        SELECT evidence.*, receipt.id AS receipt_id
        FROM tool_evidence evidence
        JOIN tool_evidence_receipts receipt
          ON receipt.evidence_id = evidence.id
         AND receipt.status = 'consumed'
        WHERE evidence.work_item_id = ?
        ORDER BY evidence.created_at, evidence.id
      `)
      .all(id) as Row[];
    return rows.map((row) => ({
      id: String(row.id),
      workItemId: String(row.work_item_id),
      runId: String(row.run_id),
      attemptId: String(row.attempt_id),
      receiptId: String(row.receipt_id),
      provenance: "control_plane_receipt",
      callHash: String(row.call_hash),
      toolName: String(row.tool_name),
      status: String(row.status) as ToolExecutionEvidenceRecord["status"],
      inputHash: String(row.input_hash),
      outputHash: row.output_hash ? String(row.output_hash) : null,
      paths: JSON.parse(String(row.paths_json)) as string[],
      durationMs: Number(row.duration_ms),
      createdAt: String(row.created_at),
    }));
  }

  latestArtifact(id: string): ArtifactEvidence | null {
    this.get(id);
    const row = this.database
      .prepare(`
        SELECT id, work_item_id, run_id, sha256, storage_name,
               media_type, byte_size, producer_report_json,
               producer_report_hash, producer_report_byte_size, created_at
        FROM artifacts
        WHERE work_item_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      `)
      .get(id) as Row | undefined;
    if (!row) return null;
    const storageName = String(row.storage_name);
    const storedSha256 = String(row.sha256);
    if (
      !/^[a-f0-9]{64}$/u.test(storedSha256) ||
      storageName !== `${storedSha256}.txt`
    ) {
      throw new Error("Artifact storage name is invalid.");
    }
    const artifactBytes = readFileSync(join(this.artifactDirectory, storageName));
    if (
      artifactBytes.byteLength !== Number(row.byte_size) ||
      createHash("sha256").update(artifactBytes).digest("hex") !== storedSha256
    ) {
      throw new Error("ARTIFACT_INTEGRITY_MISMATCH");
    }
    let producerReport: ArtifactProducerReport | undefined;
    let producerReportHash: string | undefined;
    if (row.producer_report_json !== null && row.producer_report_json !== undefined) {
      try {
        producerReport = normalizeArtifactProducerReport(
          JSON.parse(String(row.producer_report_json)) as unknown,
        );
      } catch {
        throw new Error("ARTIFACT_PRODUCER_REPORT_INVALID");
      }
      producerReportHash = String(row.producer_report_hash ?? "");
      if (
        !/^[a-f0-9]{64}$/u.test(producerReportHash) ||
        canonicalHash(producerReport) !== producerReportHash ||
        Buffer.byteLength(String(row.producer_report_json)) !==
          Number(row.producer_report_byte_size)
      ) {
        throw new Error("ARTIFACT_PRODUCER_REPORT_HASH_MISMATCH");
      }
    } else if (
      (row.producer_report_hash !== null &&
        row.producer_report_hash !== undefined) ||
      Number(row.producer_report_byte_size) !== 0
    ) {
      throw new Error("ARTIFACT_PRODUCER_REPORT_INVALID");
    }
    return {
      id: String(row.id),
      workItemId: String(row.work_item_id),
      runId: String(row.run_id),
      sha256: storedSha256,
      mediaType: String(row.media_type),
      byteSize: Number(row.byte_size),
      content: artifactBytes.toString("utf8"),
      ...(producerReport && producerReportHash
        ? {
            producerReport,
            producerReportHash,
            producerReportByteSize: Number(row.producer_report_byte_size),
          }
        : {}),
      createdAt: String(row.created_at),
    };
  }

  get(id: string): WorkItem {
    const row = this.database
      .prepare("SELECT * FROM work_items WHERE id = ?")
      .get(id) as Row | undefined;
    if (!row) throw new Error(`Unknown work item '${id}'.`);
    return asWorkItem(row);
  }

  list(options: { includeArchived?: boolean } = {}): WorkItem[] {
    return (
      this.database
        .prepare(`
          SELECT * FROM work_items
          WHERE archived_at IS NULL OR ? = 1
          ORDER BY
            CASE availability WHEN 'ready' THEN 0 ELSE 1 END,
            priority DESC,
            updated_at DESC
        `)
        .all(options.includeArchived ? 1 : 0) as Row[]
    ).map(asWorkItem);
  }

  listPage(
    options: {
      cursor?: string;
      limit?: number;
      includeCompleted?: boolean;
      includeArchived?: boolean;
    } = {},
  ): WorkItemPage {
    const cursor = parseWorkCursor(options.cursor);
    const limit = Math.min(
      500,
      Math.max(1, Math.floor(options.limit ?? 100)),
    );
    const clauses = [
      options.includeArchived ? "1 = 1" : "archived_at IS NULL",
      options.includeCompleted
        ? "1 = 1"
        : "status NOT IN ('done', 'canceled')",
      cursor
        ? "(created_at < ? OR (created_at = ? AND id < ?))"
        : "1 = 1",
    ];
    const parameters: Array<string | number> = [];
    if (cursor) {
      parameters.push(cursor.createdAt, cursor.createdAt, cursor.id);
    }
    parameters.push(limit + 1);
    const rows = this.database
      .prepare(`
        SELECT * FROM work_items
        WHERE ${clauses.join(" AND ")}
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      `)
      .all(...parameters) as Row[];
    const hasNext = rows.length > limit;
    const pageRows = rows.slice(0, limit);
    return {
      items: pageRows.map(asWorkItem),
      nextCursor:
        hasNext && pageRows.length > 0
          ? workCursor(pageRows.at(-1)!)
          : null,
    };
  }

  nextClaimableWork(): WorkItem | null {
    const row = this.database
      .prepare(`
        SELECT * FROM work_items
        WHERE archived_at IS NULL
          AND availability = 'ready'
          AND status IN ('ready', 'changes_requested')
        ORDER BY priority DESC, updated_at ASC, id ASC
        LIMIT 1
      `)
      .get() as Row | undefined;
    return row ? asWorkItem(row) : null;
  }

  dashboard(
    options: { cursor?: string; limit?: number } = {},
  ): DashboardProjection {
    const page = this.listPage({
      cursor: options.cursor,
      limit: options.limit ?? 200,
      includeCompleted: true,
    });
    const pendingToolApprovalIds = new Set(
      (
        this.database
          .prepare(`
            SELECT pending.work_item_id, pending.arguments_json
            FROM pending_tool_calls pending
            LEFT JOIN tool_approvals approval
              ON approval.work_item_id = pending.work_item_id
             AND approval.call_hash = pending.call_hash
             AND approval.tool_name = pending.tool_name
            WHERE pending.status = 'approval_required'
              AND approval.id IS NULL
          `)
          .all() as Row[]
      ).flatMap((row) => {
        try {
          const argumentsValue = JSON.parse(String(row.arguments_json)) as
            | Record<string, unknown>
            | unknown;
          if (
            argumentsValue &&
            typeof argumentsValue === "object" &&
            !Array.isArray(argumentsValue) &&
            typeof argumentsValue.unparsed === "string"
          ) {
            return [];
          }
          return [String(row.work_item_id)];
        } catch {
          return [];
        }
      }),
    );
    const humanCandidateItems = (
      this.database
        .prepare(`
          SELECT *
          FROM work_items
          WHERE archived_at IS NULL
            AND status NOT IN ('done', 'canceled', 'failed')
            AND (
              status = 'review_pending'
              OR availability = 'user_input_waiting'
              OR (
                status = 'in_progress'
                AND availability = 'approval_waiting'
              )
            )
        `)
        .all() as Row[]
    ).map(asWorkItem);
    const humanDecisionPairs = humanCandidateItems
      .map((item) => ({
        item,
        action: this.projectAction(
          item,
          pendingToolApprovalIds.has(item.id),
        ),
      }))
      .filter(
        ({ action }) => action.actor === "human" && action.actionable,
      )
      .sort(
        (left, right) =>
          right.action.priority - left.action.priority ||
          left.item.updatedAt.localeCompare(right.item.updatedAt) ||
          left.item.id.localeCompare(right.item.id),
      );
    const visibleDecisionItems = humanDecisionPairs
      .slice(0, 100)
      .map(({ item }) => item);
    const workItems = [
      ...new Map(
        [...visibleDecisionItems, ...page.items].map((item) => [item.id, item]),
      ).values(),
    ];
    const userActions = workItems
      .filter(({ status }) => !["done", "canceled"].includes(status))
      .map((item) =>
        this.projectAction(item, pendingToolApprovalIds.has(item.id)),
      )
      .sort(
        (left, right) =>
          right.priority - left.priority ||
          left.workItemId.localeCompare(right.workItemId),
      );
    const agentActionRow = this.database
      .prepare(`
        SELECT COUNT(*) AS count
        FROM work_items
        WHERE archived_at IS NULL
          AND (
            (status = 'requested' AND availability NOT IN ('user_input_waiting', 'approval_waiting'))
            OR (availability = 'ready' AND status IN ('ready', 'changes_requested'))
            OR (status = 'in_progress' AND availability = 'ready')
            OR status = 'approved'
          )
      `)
      .get() as Row;
    const historyRow = this.database
      .prepare(`
        SELECT COUNT(*) AS count,
               SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
        FROM work_items
        WHERE archived_at IS NULL
          AND status IN ('done', 'canceled', 'failed')
      `)
      .get() as Row;
    const activeRow = this.database
      .prepare(`
        SELECT COUNT(*) AS count
        FROM work_items
        WHERE archived_at IS NULL
          AND status NOT IN ('done', 'canceled', 'failed')
      `)
      .get() as Row;
    const humanDecisions = humanDecisionPairs.length;
    const agentActions = Number(agentActionRow.count ?? 0);
    const waiting = Math.max(
      0,
      Number(activeRow.count ?? 0) - humanDecisions - agentActions,
    );
    const events = this.database
      .prepare(`
        SELECT id, event_type, work_item_id, actor, created_at
        FROM events ORDER BY id DESC LIMIT 30
      `)
      .all() as Row[];
    return {
      summary: {
        actionable: humanDecisions + agentActions,
        approvals: humanDecisionPairs.filter(
          ({ action }) => action.category === "human_review",
        ).length,
        userInput: humanDecisionPairs.filter(
          ({ action }) => action.category === "user_input",
        ).length,
        failed: Number(historyRow.failed ?? 0),
        humanDecisions,
        agentActions,
        waiting,
        history: Number(historyRow.count ?? 0),
      },
      attention: {
        primaryDecision: humanDecisionPairs[0]?.action ?? null,
        queueTruncated: humanDecisionPairs.length > 100,
      },
      workItems,
      userActions,
      recentEvents: events.map((event) => ({
        id: Number(event.id),
        type: String(event.event_type),
        workItemId: event.work_item_id ? String(event.work_item_id) : null,
        actor: String(event.actor),
        createdAt: String(event.created_at),
      })),
      page: { nextCursor: page.nextCursor },
    };
  }

  private projectAction(
    item: WorkItem,
    hasPendingToolApproval = false,
  ): UserAction {
    if (
      hasPendingToolApproval &&
      item.status === "in_progress" &&
      item.availability === "approval_waiting"
    ) {
      return this.action(
        item,
        "human_review",
        "Review exact pending tool arguments.",
        true,
        110,
      );
    }
    if (item.status === "review_pending") {
      return this.action(item, "human_review", "Review immutable artifact.", true, 100);
    }
    if (item.availability === "user_input_waiting") {
      return this.action(item, "user_input", item.wait?.reason ?? "Input required.", true, 90);
    }
    if (item.status === "failed") {
      return this.action(
        item,
        "retry",
        "Failure is retained for inspection.",
        false,
        5,
      );
    }
    if (item.status === "approved") {
      return this.action(
        item,
        "complete",
        "Finalize the already approved work.",
        true,
        50,
      );
    }
    if (item.status === "requested") {
      return this.action(item, "triage", "Assign role and runtime.", true, 70);
    }
    if (item.availability === "ready" && item.status === "changes_requested") {
      return this.action(item, "resume", "Apply requested changes.", true, 65);
    }
    if (item.availability === "ready" && item.status === "ready") {
      return this.action(item, "start", "Work is ready to claim.", true, 60);
    }
    if (item.status === "in_progress" && item.availability === "ready") {
      return this.action(item, "resume", "Continue the active work.", true, 55);
    }
    return this.action(
      item,
      "waiting",
      item.wait?.reason ?? item.nextAction,
      false,
      10,
    );
  }

  private action(
    item: WorkItem,
    category: UserAction["category"],
    reason: string,
    actionable: boolean,
    priority: number,
  ): UserAction {
    return {
      id: `action:${item.id}:${category}`,
      workItemId: item.id,
      category,
      reason,
      actor:
        category === "human_review" || category === "user_input"
          ? "human"
          : "role",
      cta: item.nextAction,
      actionable,
      blockedBy:
        item.availability === "dependency_waiting"
          ? this.blockingPredecessors(item.id)
          : [],
      priority,
      ...(item.wait?.resumeAt ? { expiresAt: item.wait.resumeAt } : {}),
    };
  }

  private assertActiveGeneration(id: string, generation: number): void {
    const row = this.database
      .prepare(`
        SELECT generation
        FROM runs
        WHERE work_item_id = ? AND status = 'running'
        ORDER BY generation DESC LIMIT 1
      `)
      .get(id) as Row | undefined;
    if (!row || Number(row.generation) !== generation) {
      throw new Error("Stale or inactive run generation.");
    }
  }

  private assertVersion(item: WorkItem, expected?: number): void {
    if (expected !== undefined && item.version !== expected) {
      throw new Error(
        `Version conflict: expected ${expected}, current ${item.version}.`,
      );
    }
  }

  private blockingPredecessors(id: string): string[] {
    const rows = this.database
      .prepare(`
        SELECT d.predecessor_id
        FROM dependencies d
        JOIN work_items predecessor ON predecessor.id = d.predecessor_id
        WHERE d.work_item_id = ? AND d.active = 1
          AND predecessor.status != 'done'
        ORDER BY d.predecessor_id
      `)
      .all(id) as Row[];
    return rows.map(({ predecessor_id }) => String(predecessor_id));
  }

  private reachable(start: string, target: string): boolean {
    const queue = [start];
    const visited = new Set<string>();
    while (queue.length > 0) {
      const current = queue.shift();
      if (!current || visited.has(current)) continue;
      if (current === target) return true;
      visited.add(current);
      const rows = this.database
        .prepare(`
          SELECT predecessor_id
          FROM dependencies
          WHERE work_item_id = ? AND active = 1
        `)
        .all(current) as Row[];
      queue.push(...rows.map(({ predecessor_id }) => String(predecessor_id)));
    }
    return false;
  }
}
