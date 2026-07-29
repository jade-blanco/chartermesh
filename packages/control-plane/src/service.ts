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
  ArtifactEvidence,
  DashboardProjection,
  RuntimeBudgets,
  UserAction,
  WaitCondition,
  WorkItem,
  WorkStatus,
} from "./types.ts";

type Row = Record<string, unknown>;

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

export class ControlPlane {
  private readonly database: DatabaseSync;
  private readonly artifactDirectory: string;
  private readonly budgets?: RuntimeBudgets;

  constructor(
    database: DatabaseSync,
    artifactDirectory: string,
    options: { budgets?: RuntimeBudgets } = {},
  ) {
    this.database = database;
    this.artifactDirectory = artifactDirectory;
    this.budgets = options.budgets;
    mkdirSync(artifactDirectory, { recursive: true });
  }

  private assertRunBudgets(): void {
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

  private command<T>(
    idempotencyKey: string,
    command: string,
    operation: () => T,
  ): T {
    assertText(idempotencyKey, "idempotencyKey");
    return transaction(this.database, () => {
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
    return transaction(this.database, () => {
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
      const content = assertText(input.content, "artifact content");
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
          Buffer.byteLength(content),
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
    return transaction(this.database, () => {
      const id = this.nextId("invocation");
      const stamp = now();
      this.database
        .prepare(`
          INSERT INTO model_invocations(
            id, attempt_id, engine_id, model_id, status, input_tokens,
            output_tokens, cost, measurement_status, started_at, finished_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          id,
          input.attemptId,
          input.engineId,
          input.modelId,
          input.status,
          input.inputTokens,
          input.outputTokens,
          input.cost,
          input.measurementStatus,
          stamp,
          stamp,
        );
      return id;
    });
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

  list(): WorkItem[] {
    return (
      this.database
        .prepare(`
          SELECT * FROM work_items
          ORDER BY
            CASE availability WHEN 'ready' THEN 0 ELSE 1 END,
            priority DESC,
            updated_at DESC
        `)
        .all() as Row[]
    ).map(asWorkItem);
  }

  dashboard(): DashboardProjection {
    const workItems = this.list();
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
