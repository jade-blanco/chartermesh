import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type {
  AuditRecord,
  ArtifactEvidence,
  DashboardProjection,
  ModelInvocationRecord,
  OperationalState,
  OutboxDelivery,
  OutboxRecord,
  RuntimeBudgets,
  ScheduleTickRecord,
  ToolCallApproval,
  ToolExecutionEvidenceRecord,
  UserAction,
  WaitCondition,
  WorkItem,
  WorkItemPage,
  WorkStatus,
} from "./types.ts";
import { assertMaintenanceInactive } from "./maintenance.ts";

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
        "SELECT COUNT(*) AS count FROM runs WHERE status IN ('running', 'waiting')",
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
      this.event("work.intake.created", id, input.actor, { rootId });
      return this.get(id);
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
      if (["done", "canceled"].includes(current.status)) {
        throw new Error("Terminal work cannot be triaged.");
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
      this.database
        .prepare(`
          UPDATE work_items
          SET status = 'failed', availability = 'ready',
              next_action = 'Inspect the failure and retry.',
              version = version + 1, updated_at = ?
          WHERE id = ?
        `)
        .run(stamp, input.id);
      this.event("run.failed", input.id, input.actor, {
        runId: String(run.id),
        attemptId: input.attemptId,
        generation: input.generation,
        errorCode: code,
      });
      return this.get(input.id);
    });
  }

  retry(input: {
    id: string;
    actor: string;
    idempotencyKey: string;
  }): WorkItem {
    return this.command(input.idempotencyKey, "run.retry", () => {
      const current = this.get(input.id);
      if (current.status !== "failed") {
        throw new Error("Only failed work can be retried.");
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
      this.event("run.retry.requested", input.id, input.actor);
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
            WHERE attempt_id = ? AND status = 'running'
            ORDER BY id
          `)
          .all(String(row.attempt_id)) as Row[];
        this.database
          .prepare(`
            UPDATE attempts
            SET status = 'failed', finished_at = ?,
                error_code = 'LEASE_EXPIRED',
                error_message = 'The worker lease expired before completion.'
            WHERE id = ? AND status = 'running'
          `)
          .run(stamp, String(row.attempt_id));
        this.database
          .prepare(`
            UPDATE model_invocations
            SET status = 'abandoned', finished_at = ?
            WHERE attempt_id = ? AND status = 'running'
          `)
          .run(stamp, String(row.attempt_id));
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
        this.database
          .prepare(`
            UPDATE work_items
            SET status = 'failed', availability = 'ready',
                next_action = 'The previous lease expired. Inspect and retry.',
                version = version + 1, updated_at = ?
            WHERE id = ? AND status = 'in_progress'
          `)
          .run(stamp, workItemId);
        this.event("lease.expired", workItemId, actor, {
          leaseId: String(row.lease_id),
          runId: String(row.run_id),
          generation: Number(row.generation),
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
    generation: number;
    actor: string;
    idempotencyKey: string;
  }): { workItem: WorkItem; artifactId: string; sha256: string } {
    return this.command(input.idempotencyKey, "artifact.submit", () => {
      const current = this.get(input.id);
      if (current.status !== "in_progress") {
        throw new Error("Only in-progress work can submit an artifact.");
      }
      this.assertActiveGeneration(input.id, input.generation);
      const content = input.content;
      if (!content.trim()) throw new Error("artifact content is required.");
      const byteSize = Buffer.byteLength(content);
      const maxArtifactBytes =
        this.budgets?.maxArtifactBytes ?? DEFAULT_MAX_ARTIFACT_BYTES;
      if (byteSize > maxArtifactBytes) {
        throw new Error("ARTIFACT_SIZE_LIMIT_EXCEEDED");
      }
      const priorBytes = this.database
        .prepare(
          `SELECT COALESCE(SUM(byte_size), 0) AS bytes
           FROM artifacts WHERE work_item_id = ?`,
        )
        .get(input.id) as Row;
      const maxWorkItemArtifactBytes =
        this.budgets?.maxWorkItemArtifactBytes ??
        DEFAULT_MAX_WORK_ITEM_ARTIFACT_BYTES;
      if (Number(priorBytes.bytes) + byteSize > maxWorkItemArtifactBytes) {
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
            media_type, byte_size, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          artifactId,
          input.id,
          String(run.id),
          digest,
          storageName,
          input.mediaType ?? "text/plain",
          byteSize,
          now(),
        );
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
        .run(digest, input.actor, now(), input.id);
      this.event("artifact.submitted", input.id, input.actor, {
        artifactId,
        sha256: digest,
      });
      return { workItem: this.get(input.id), artifactId, sha256: digest };
    });
  }

  decide(input: {
    id: string;
    decision: "approve" | "changes_requested" | "reject";
    artifactHash: string;
    note: string;
    actor: string;
    idempotencyKey: string;
  }): WorkItem {
    return this.command(input.idempotencyKey, "approval.decide", () => {
      const current = this.get(input.id);
      if (current.status !== "review_pending") {
        throw new Error("Work is not waiting for review.");
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
      const approvalId = this.nextId("approval");
      this.database
        .prepare(`
          INSERT INTO approvals(
            id, work_item_id, artifact_hash, decision, note, actor, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          approvalId,
          input.id,
          String(artifact.sha256),
          input.decision,
          assertText(input.note, "decision note"),
          input.actor,
          now(),
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
        .run(nextStatus, availability, nextAction, now(), input.id);
      this.database
        .prepare(`
          UPDATE runs SET status = ?, finished_at = ?
          WHERE work_item_id = ? AND status IN ('running', 'waiting')
        `)
        .run(
          input.decision === "approve" ? "succeeded" : nextStatus,
          now(),
          input.id,
        );
      this.database
        .prepare(`
          UPDATE leases SET released_at = ?
          WHERE run_id IN (SELECT id FROM runs WHERE work_item_id = ?)
            AND released_at IS NULL
        `)
        .run(now(), input.id);
      this.event("approval.decided", input.id, input.actor, {
        approvalId,
        decision: input.decision,
        artifactHash: artifact.sha256,
      });
      return this.get(input.id);
    });
  }

  complete(input: {
    id: string;
    actor: string;
    idempotencyKey: string;
  }): { workItem: WorkItem; resurfaced: string[] } {
    return this.command(input.idempotencyKey, "work.complete", () => {
      const current = this.get(input.id);
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
        .run(now(), input.id);
      this.event("work.completed", input.id, input.actor);

      const successorRows = this.database
        .prepare(`
          SELECT work_item_id
          FROM dependencies
          WHERE predecessor_id = ? AND active = 1
        `)
        .all(input.id) as Row[];
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
            .run(now(), successorId);
          if (Number(update.changes) > 0) {
            resurfaced.push(successorId);
            this.event("work.resurfaced", successorId, input.actor, {
              completedPredecessor: input.id,
            });
          }
        }
      }
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

  approveToolCall(input: {
    id: string;
    callHash: string;
    toolName: string;
    actor: string;
    note: string;
    idempotencyKey: string;
  }): ToolCallApproval {
    return this.command(input.idempotencyKey, "tool.approve", () => {
      this.get(input.id);
      if (!input.actor.startsWith("human:")) {
        throw new Error("Tool approval authority must be a human actor.");
      }
      if (!/^[a-f0-9]{64}$/u.test(input.callHash)) {
        throw new Error("callHash must be a SHA-256 digest.");
      }
      const toolName = assertText(input.toolName, "toolName");
      const approvalId = this.nextId("tool-approval");
      const createdAt = now();
      this.database
        .prepare(`
          INSERT INTO tool_approvals(
            id, work_item_id, call_hash, tool_name, actor, note, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          approvalId,
          input.id,
          input.callHash,
          toolName,
          input.actor,
          assertText(input.note, "note"),
          createdAt,
        );
      this.event("tool.approved", input.id, input.actor, {
        approvalId,
        callHash: input.callHash,
        toolName,
      });
      return {
        id: approvalId,
        workItemId: input.id,
        callHash: input.callHash,
        toolName,
        actor: input.actor,
        note: input.note.trim(),
        createdAt,
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

  recordToolEvidence(input: {
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
        this.get(input.id);
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
        const record: ToolExecutionEvidenceRecord = {
          id: input.evidenceId,
          workItemId: input.id,
          runId: input.runId,
          attemptId: input.attemptId,
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
        this.event("tool.executed", input.id, input.actor, {
          evidenceId: record.id,
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
        SELECT *
        FROM tool_evidence
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
               media_type, byte_size, created_at
        FROM artifacts
        WHERE work_item_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      `)
      .get(id) as Row | undefined;
    if (!row) return null;
    const storageName = String(row.storage_name);
    if (!/^[a-f0-9]{64}\.txt$/u.test(storageName)) {
      throw new Error("Artifact storage name is invalid.");
    }
    return {
      id: String(row.id),
      workItemId: String(row.work_item_id),
      runId: String(row.run_id),
      sha256: String(row.sha256),
      mediaType: String(row.media_type),
      byteSize: Number(row.byte_size),
      content: readFileSync(join(this.artifactDirectory, storageName), "utf8"),
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
    const workItems = page.items;
    const userActions = workItems
      .filter(({ status }) => !["done", "canceled"].includes(status))
      .map((item) => this.projectAction(item))
      .sort(
        (left, right) =>
          right.priority - left.priority ||
          left.workItemId.localeCompare(right.workItemId),
      );
    const events = this.database
      .prepare(`
        SELECT id, event_type, work_item_id, actor, created_at
        FROM events ORDER BY id DESC LIMIT 30
      `)
      .all() as Row[];
    return {
      summary: {
        actionable: userActions.filter(({ actionable }) => actionable).length,
        approvals: userActions.filter(
          ({ category }) => category === "human_review",
        ).length,
        userInput: userActions.filter(
          ({ category }) => category === "user_input",
        ).length,
        failed: workItems.filter(({ status }) => status === "failed").length,
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

  private projectAction(item: WorkItem): UserAction {
    if (item.status === "review_pending") {
      return this.action(item, "human_review", "Review immutable artifact.", true, 100);
    }
    if (item.availability === "user_input_waiting") {
      return this.action(item, "user_input", item.wait?.reason ?? "Input required.", true, 90);
    }
    if (item.status === "failed") {
      return this.action(item, "retry", "Inspect failure and retry.", true, 80);
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
