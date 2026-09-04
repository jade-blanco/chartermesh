import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ControlPlane,
  buildDecisionPacket,
  canonicalHash,
  createDecisionContract,
  dispatchOutboxBatch,
  normalizeArtifactProducerReport,
  openControlPlaneDatabase,
  projectDecisionReviewView,
  projectApprovalExplanation,
  type ArtifactProducerReport,
  type ActiveRunFence,
  type ToolExecutionEvidenceRecord,
} from "../src/index.ts";
import {
  createWorkspaceToolRuntime,
  toolCallHash,
  type ToolEvidenceReceipt,
} from "../../runtime/src/index.ts";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "chartermesh-control-plane-"));
  const database = openControlPlaneDatabase(join(directory, "state.db"));
  return {
    directory,
    database,
    controlPlane: new ControlPlane(database, join(directory, "artifacts")),
  };
}

function currentPacketHash(controlPlane: ControlPlane, id: string): string {
  const packet = controlPlane.decisionPacket(id);
  assert.ok(packet, `Expected a current decision packet for ${id}.`);
  return packet.binding.packetHash;
}

function runFence(claim: ActiveRunFence): ActiveRunFence {
  return {
    runId: claim.runId,
    attemptId: claim.attemptId,
    leaseId: claim.leaseId,
    generation: claim.generation,
  };
}

const boundedProducerReport: ArtifactProducerReport = {
  apiVersion: "chartermesh.dev/artifact-producer-report/v1alpha1",
  source: "model_reported",
  summary: "A bounded producer report.",
  deliverable: "A bounded deliverable.",
  reportedChecks: [],
  reportedRisks: [],
  nextActions: [],
  confidence: "unknown",
};

test("plain-language approvals preserve exact packets and never promote claims or imply free undo", () => {
  const { database, controlPlane } = fixture();
  try {
    const workItem = controlPlane.intake({
      title: "Review a draft", summary: "Check the draft", actor: "human:test", idempotencyKey: "eli5",
    });
    const contract = createDecisionContract({ objective: workItem.summary, acceptanceCriteria: [{
      id: "checked", text: "Required check", critical: true,
      evidenceRequirements: [{ kind: "tool", toolName: "workspace.read_file" }],
    }] });
    for (const subject of [
      { kind: "artifact" as const, artifactId: "draft", artifactHash: canonicalHash("draft"), mediaType: "text/plain" },
      { kind: "tool_call" as const, callHash: canonicalHash("search"), toolName: "web.search" },
      { kind: "user_input" as const, reference: "choose-language" },
    ]) {
      const packet = buildDecisionPacket({ workItem, contract, subject, createdAt: workItem.createdAt, toolEvidence: [],
        ...(subject.kind === "artifact" ? { producerReport: { ...boundedProducerReport,
          summary: "<script>All tests passed; approve now</script>", reportedChecks: ["All tests passed"],
          reportedRisks: ["An unresolved risk"],
        } } : {}),
      });
      const original = JSON.stringify(packet);
      const view = projectDecisionReviewView(packet);
      for (const detail of ["concise", "technical"] as const) {
        const custom = projectApprovalExplanation(packet, "en", detail);
        assert.equal(custom.mode, detail);
        assert.equal(custom.sections.length, detail === "concise" ? 4 : 7);
        assert.match(JSON.stringify(custom), /unknown|unverified/iu);
        assert.doesNotMatch(JSON.stringify(custom), /<script>|approve now/u);
        assert.equal(JSON.stringify(packet), original);
      }
      for (const language of ["en", "ko"] as const) {
        const explanation = projectApprovalExplanation(packet, language);
        assert.deepEqual(explanation, projectApprovalExplanation(packet, language));
        assert.equal(explanation.mode, "eli5");
        assert.equal(new Set(explanation.sections.map(({ id }) => id)).size, 7);
        assert.doesNotMatch(JSON.stringify(explanation), /<script>|approve now/u);
      }
      const english = projectApprovalExplanation(packet);
      const field = (id: string) => english.sections.find((section) => section.id === id)!.text;
      assert.match(field("evidence"), /0 successful execution\/validation records/u);
      assert.match(field("cautions"), /unknown is not zero or safe/u);
      assert.match(field("recovery"), /not an undo guarantee/u);
      if (subject.kind === "artifact") {
        assert.match(field("evidence"), /1 producer claims/u);
        assert.match(field("cautions"), /1 blocking issues/u);
        assert.match(field("effect"), /does not authorize publishing/u);
      } else if (subject.kind === "tool_call") {
        assert.match(field("alternatives"), /cancels this work item/u);
        assert.match(field("effect"), /does not mean it has run/u);
      } else {
        assert.match(field("effect"), /Do not include passwords/u);
      }
      assert.equal(JSON.stringify(packet), original);
      assert.deepEqual(projectDecisionReviewView(packet), view);
    }
  } finally { database.close(); }
});

test("producer reports and packet evidence reject ambiguous boundary inputs", () => {
  const disguisedSparseChecks = Array<string>(2);
  disguisedSparseChecks[0] = "Only one indexed entry exists.";
  Object.defineProperty(disguisedSparseChecks, "extra", {
    enumerable: true,
    value: "This made Object.keys(array).length equal array.length.",
  });
  assert.throws(
    () =>
      normalizeArtifactProducerReport({
        ...boundedProducerReport,
        reportedChecks: Array(1),
      }),
    /PRODUCER_REPORT_INVALID/u,
  );
  assert.throws(
    () =>
      normalizeArtifactProducerReport({
        ...boundedProducerReport,
        reportedChecks: disguisedSparseChecks,
      }),
    /PRODUCER_REPORT_INVALID/u,
  );
  assert.throws(
    () =>
      normalizeArtifactProducerReport({
        ...boundedProducerReport,
        summary: "embedded\0NUL",
      }),
    /PRODUCER_REPORT_INVALID/u,
  );
  assert.throws(
    () =>
      normalizeArtifactProducerReport({
        ...boundedProducerReport,
        reportedChecks: ["embedded\0NUL"],
      }),
    /PRODUCER_REPORT_INVALID/u,
  );
  const unicodeReport = normalizeArtifactProducerReport({
    ...boundedProducerReport,
    summary: "😀".repeat(2_000),
  });
  assert.equal(Array.from(unicodeReport.summary).length, 2_000);
  assert.throws(
    () =>
      normalizeArtifactProducerReport({
        ...boundedProducerReport,
        summary: "😀".repeat(2_001),
      }),
    /PRODUCER_REPORT_INVALID/u,
  );

  const workItem = {
    id: "work-boundary",
    rootId: "work-boundary",
    parentId: null,
    title: "Boundary",
    summary: "Exercise the packet boundary.",
    ownerRole: "operator",
    executionTarget: "local",
    status: "in_progress" as const,
    availability: "approval_waiting" as const,
    priority: 50,
    version: 1,
    wait: null,
    nextAction: "Review",
    archivedAt: null,
    createdAt: "2026-08-02T00:00:00.000Z",
    updatedAt: "2026-08-02T00:00:00.000Z",
  };
  const contract = createDecisionContract({
    objective: workItem.summary,
    source: "user",
  });
  assert.throws(
    () =>
      buildDecisionPacket({
        workItem,
        contract,
        subject: {
          kind: "tool_call",
          callHash: canonicalHash("bounded-call"),
          toolName: "workspace.read_file",
        },
        producerReport: boundedProducerReport,
        toolEvidence: [],
        createdAt: workItem.createdAt,
      }),
    /PRODUCER_REPORT_INVALID/u,
  );

  const nonArtifactPacket = buildDecisionPacket({
    workItem,
    contract,
    subject: {
      kind: "tool_call",
      callHash: canonicalHash("bounded-call"),
      toolName: "workspace.read_file",
    },
    producerReport: null,
    toolEvidence: [],
    createdAt: workItem.createdAt,
  });
  assert.equal(nonArtifactPacket.producerReport, null);
  assert.equal(nonArtifactPacket.binding.producerReportHash, null);
  assert.throws(
    () =>
      buildDecisionPacket({
        workItem,
        contract,
        subject: {
          kind: "tool_call",
          callHash: canonicalHash("bounded-call"),
          toolName: "workspace.read_file",
        },
        producerReport: null,
        toolEvidence: [],
        createdAt: workItem.createdAt,
        question: "embedded\0NUL",
      }),
    /TEXT_INVALID/u,
  );
  assert.throws(
    () =>
      buildDecisionPacket({
        workItem,
        contract: {
          ...contract,
          decisionQuestion: "fallback\0NUL",
        },
        subject: {
          kind: "tool_call",
          callHash: canonicalHash("bounded-call"),
          toolName: "workspace.read_file",
        },
        producerReport: null,
        toolEvidence: [],
        createdAt: workItem.createdAt,
      }),
    /TEXT_INVALID/u,
  );

  const toolEvidence: ToolExecutionEvidenceRecord[] = Array.from(
    { length: 500 },
    (_, index) => ({
      id: `evidence-${index}`,
      workItemId: workItem.id,
      runId: "run-boundary",
      attemptId: "attempt-boundary",
      receiptId: `receipt-${index}`,
      provenance: "control_plane_receipt",
      callHash: canonicalHash({ index, kind: "call" }),
      toolName: "workspace.read_file",
      status: "succeeded",
      inputHash: canonicalHash({ index, kind: "input" }),
      outputHash: canonicalHash({ index, kind: "output" }),
      paths: [],
      durationMs: 1,
      createdAt: workItem.createdAt,
    }),
  );
  const disguisedSparseEvidence = Array<ToolExecutionEvidenceRecord>(2);
  disguisedSparseEvidence[0] = toolEvidence[0]!;
  Object.defineProperty(disguisedSparseEvidence, "extra", {
    enumerable: true,
    value: toolEvidence[1],
  });
  assert.throws(
    () =>
      buildDecisionPacket({
        workItem,
        contract,
        subject: {
          kind: "tool_call",
          callHash: canonicalHash("bounded-call"),
          toolName: "workspace.read_file",
        },
        toolEvidence: disguisedSparseEvidence,
        createdAt: workItem.createdAt,
      }),
    /DECISION_PACKET_EVIDENCE_INVALID/u,
  );
  const maximumPacket = buildDecisionPacket({
    workItem,
    contract,
    subject: {
      kind: "tool_call",
      callHash: canonicalHash("bounded-call"),
      toolName: "workspace.read_file",
    },
    toolEvidence: toolEvidence.slice(0, 499),
    createdAt: workItem.createdAt,
  });
  assert.equal(maximumPacket.evidence.length, 500);
  assert.throws(
    () =>
      buildDecisionPacket({
        workItem,
        contract,
        subject: {
          kind: "tool_call",
          callHash: canonicalHash("bounded-call"),
          toolName: "workspace.read_file",
        },
        toolEvidence,
        createdAt: workItem.createdAt,
      }),
    /DECISION_PACKET_EVIDENCE_LIMIT/u,
  );
});

test("v1alpha2 schemas mirror runtime whitespace and NUL boundaries", () => {
  const producerSchema = JSON.parse(
    readFileSync("schemas/artifact-producer-report-v1alpha1.schema.json", "utf8"),
  ) as {
    properties: {
      summary: Record<string, unknown>;
      deliverable: Record<string, unknown>;
    };
    $defs: { stringList: { items: Record<string, unknown> } };
  };
  for (const boundary of [
    producerSchema.properties.summary,
    producerSchema.properties.deliverable,
    producerSchema.$defs.stringList.items,
  ]) {
    assert.equal(boundary.pattern, "\\S");
    assert.deepEqual(boundary.not, { pattern: "\\u0000" });
  }

  const packetSchema = JSON.parse(
    readFileSync("schemas/decision-packet-v1alpha2.schema.json", "utf8"),
  ) as {
    properties: {
      question: Record<string, unknown>;
      producerReport: {
        properties: {
          summary: Record<string, unknown>;
          deliverable: Record<string, unknown>;
        };
      };
    };
    allOf: Array<Record<string, unknown>>;
    $defs: { stringList: { items: Record<string, unknown> } };
  };
  for (const boundary of [
    packetSchema.properties.question,
    packetSchema.properties.producerReport.properties.summary,
    packetSchema.properties.producerReport.properties.deliverable,
    packetSchema.$defs.stringList.items,
  ]) {
    assert.equal(boundary.pattern, "\\S");
    assert.deepEqual(boundary.not, { pattern: "\\u0000" });
  }
  const schemaText = JSON.stringify(packetSchema.allOf);
  assert.match(schemaText, /tool_execution/u);
  assert.match(schemaText, /user_input/u);
  assert.match(schemaText, /"producerReport":\{"type":"null"\}/u);
});

test("intake through approval completes and resurfaces a successor", () => {
  const { database, controlPlane } = fixture();
  try {
    const first = controlPlane.intake({
      title: "Prepare implementation",
      summary: "Create a bounded implementation artifact.",
      actor: "human:test",
      idempotencyKey: "intake:first",
    });
    const second = controlPlane.intake({
      title: "Verify implementation",
      summary: "Verify only after implementation completes.",
      actor: "human:test",
      idempotencyKey: "intake:second",
    });
    controlPlane.triage({
      id: first.id,
      ownerRole: "implementation",
      executionTarget: "simulated-local",
      actor: "human:test",
      idempotencyKey: "triage:first",
    });
    controlPlane.triage({
      id: second.id,
      ownerRole: "review",
      executionTarget: "simulated-local",
      actor: "human:test",
      idempotencyKey: "triage:second",
    });
    controlPlane.addDependency({
      id: second.id,
      predecessorId: first.id,
      actor: "human:test",
      idempotencyKey: "dependency:first-second",
    });

    assert.equal(controlPlane.get(second.id).availability, "dependency_waiting");
    assert.throws(
      () =>
        controlPlane.claim({
          id: second.id,
          actor: "role:review",
          idempotencyKey: "claim:blocked",
        }),
      /not currently claimable/u,
    );

    const claim = controlPlane.claim({
      id: first.id,
      actor: "role:implementation",
      idempotencyKey: "claim:first",
    });
    assert.equal(claim.generation, 1);
    const submission = controlPlane.submitArtifact({
      id: first.id,
      ...runFence(claim),
      content: "Synthetic implementation result.",
      actor: "role:implementation",
      idempotencyKey: "submit:first",
    });
    assert.match(submission.sha256, /^[a-f0-9]{64}$/u);
    assert.equal(submission.workItem.status, "review_pending");
    const runState = database
      .prepare("SELECT status, finished_at FROM runs WHERE id = ?")
      .get(claim.runId) as { status: string; finished_at: string | null };
    const attemptState = database
      .prepare("SELECT status, finished_at FROM attempts WHERE id = ?")
      .get(claim.attemptId) as { status: string; finished_at: string | null };
    const leaseState = database
      .prepare("SELECT released_at FROM leases WHERE id = ?")
      .get(claim.leaseId) as { released_at: string | null };
    assert.equal(runState.status, "succeeded");
    assert.ok(runState.finished_at);
    assert.equal(attemptState.status, "succeeded");
    assert.ok(attemptState.finished_at);
    assert.ok(leaseState.released_at);

    controlPlane.decide({
      id: first.id,
      decision: "approve",
      artifactHash: submission.sha256,
      packetHash: currentPacketHash(controlPlane, first.id),
      note: "The synthetic artifact satisfies the acceptance criteria.",
      actor: "human:test",
      idempotencyKey: "approve:first",
    });
    const completion = controlPlane.complete({
      id: first.id,
      actor: "role:implementation",
      idempotencyKey: "complete:first",
    });
    assert.deepEqual(completion.resurfaced, [second.id]);
    assert.equal(controlPlane.get(second.id).availability, "ready");
  } finally {
    database.close();
  }
});

test("delegated attempts retain bounded parent-child lineage", () => {
  const { database, controlPlane } = fixture();
  try {
    const work = controlPlane.intake({
      title: "Coordinate a bounded task",
      summary: "Exercise durable delegated attempt lineage.",
      actor: "human:test",
      idempotencyKey: "intake:delegated-attempts",
    });
    controlPlane.triage({
      id: work.id,
      ownerRole: "operator",
      executionTarget: "builtin-managed-runner",
      actor: "human:test",
      idempotencyKey: "triage:delegated-attempts",
    });
    const claim = controlPlane.claim({
      id: work.id,
      actor: "runner:test",
      idempotencyKey: "claim:delegated-attempts",
    });
    const planner = controlPlane.startChildAttempt({
      parentAttemptId: claim.attemptId,
      roleId: "planner",
      actor: "runner:test",
      maxChildren: 2,
    });
    const implementer = controlPlane.startChildAttempt({
      parentAttemptId: claim.attemptId,
      roleId: "implementer",
      actor: "runner:test",
      maxChildren: 2,
    });
    assert.equal(planner.parentAttemptId, claim.attemptId);
    assert.equal(planner.kind, "delegated");
    assert.equal(implementer.attemptNo, planner.attemptNo + 1);
    const delegatedReceipt = controlPlane.prepareToolEvidence({
      id: work.id,
      ...runFence(claim),
      evidenceAttemptId: planner.id,
      callHash: "1".repeat(64),
      toolName: "workspace.read_file",
      inputHash: "2".repeat(64),
      actor: "runner:test",
    });
    assert.equal(
      (
        database
          .prepare("SELECT attempt_id FROM tool_evidence_receipts WHERE id = ?")
          .get(delegatedReceipt.id) as { attempt_id: string }
      ).attempt_id,
      planner.id,
    );
    assert.throws(
      () =>
        controlPlane.startChildAttempt({
          parentAttemptId: claim.attemptId,
          roleId: "verifier",
          actor: "runner:test",
          maxChildren: 2,
        }),
      /child limit/u,
    );
    assert.throws(
      () =>
        controlPlane.startChildAttempt({
          parentAttemptId: planner.id,
          roleId: "nested",
          actor: "runner:test",
        }),
      /depth is limited/u,
    );
    assert.equal(
      controlPlane.finishChildAttempt({
        id: planner.id,
        status: "succeeded",
        actor: "runner:test",
      }).status,
      "succeeded",
    );
    assert.equal(
      controlPlane.finishChildAttempt({
        id: implementer.id,
        status: "canceled",
        actor: "runner:test",
        errorCode: "RUN_CANCELED",
        errorMessage: "Canceled by the parent signal.",
      }).status,
      "canceled",
    );
    const attempts = controlPlane.listAttempts(claim.runId);
    assert.deepEqual(
      attempts.map(({ kind, roleId, status }) => ({
        kind,
        roleId,
        status,
      })),
      [
        { kind: "primary", roleId: null, status: "running" },
        { kind: "delegated", roleId: "planner", status: "succeeded" },
        { kind: "delegated", roleId: "implementer", status: "canceled" },
      ],
    );
  } finally {
    database.close();
  }
});

test("wait conditions are explicit and actionable counts exclude blocked work", () => {
  const { database, controlPlane } = fixture();
  try {
    const item = controlPlane.intake({
      title: "Need user input",
      summary: "Wait for a user-owned configuration decision.",
      actor: "human:test",
      idempotencyKey: "intake:input",
    });
    controlPlane.triage({
      id: item.id,
      ownerRole: "operator",
      executionTarget: "simulated-local",
      actor: "human:test",
      idempotencyKey: "triage:input",
    });
    controlPlane.wait({
      id: item.id,
      condition: {
        type: "user_input",
        reason: "Choose the model endpoint.",
      },
      actor: "role:operator",
      idempotencyKey: "wait:input",
    });

    const dashboard = controlPlane.dashboard();
    assert.equal(dashboard.summary.actionable, 1);
    assert.equal(dashboard.summary.userInput, 1);
    assert.equal(dashboard.userActions[0]?.category, "user_input");
    assert.equal(dashboard.userActions[0]?.actionable, true);
    assert.throws(
      () =>
        controlPlane.resume({
          id: item.id,
          actor: "human:test",
          idempotencyKey: "resume:input-without-response",
        }),
      /provideUserInput/u,
    );
    const provided = controlPlane.provideUserInput({
      id: item.id,
      packetHash: currentPacketHash(controlPlane, item.id),
      response: "Use the loopback model endpoint at port 8080.",
      actor: "human:test",
      idempotencyKey: "provide:input",
      activeReviewMs: 321,
      detailsOpenCount: 2,
    });
    assert.equal(provided.workItem.availability, "ready");
    assert.equal(provided.workItem.wait, null);
    assert.equal("response" in provided.input, false);
    assert.match(provided.input.responseHash, /^[a-f0-9]{64}$/u);
    assert.equal(
      controlPlane.latestUserInput(item.id)?.response,
      "Use the loopback model endpoint at port 8080.",
    );
    const inputEvent = controlPlane
      .auditRecordsPage({ limit: 100 })
      .find(({ type }) => type === "user.input.provided");
    assert.equal(inputEvent?.payload.activeReviewMs, 321);
    assert.equal(inputEvent?.payload.detailsOpenCount, 2);
    assert.equal(inputEvent?.payload.reviewMeasurementStatus, "estimated");
  } finally {
    database.close();
  }
});

test("dashboard treats an unapproved pending tool call as human review", () => {
  const { database, controlPlane } = fixture();
  try {
    const item = controlPlane.intake({
      title: "Review exact tool arguments",
      summary: "A pending local write must surface in the review queue.",
      actor: "human:test",
      idempotencyKey: "tool-review:intake",
    });
    controlPlane.triage({
      id: item.id,
      ownerRole: "operator",
      executionTarget: "local",
      actor: "human:test",
      idempotencyKey: "tool-review:triage",
    });
    const claim = controlPlane.claim({
      id: item.id,
      actor: "runner:test",
      idempotencyKey: "tool-review:claim",
    });
    const callHash = "e".repeat(64);
    controlPlane.recordPendingToolCall({
      id: item.id,
      runId: claim.runId,
      attemptId: claim.attemptId,
      leaseId: claim.leaseId,
      generation: claim.generation,
      callHash,
      toolName: "workspace.write_file",
      arguments: { path: "src/result.ts", content: "export {};\n" },
      createdAt: new Date().toISOString(),
      actor: "runner:test",
      idempotencyKey: "tool-review:pending",
    });

    const beforeApproval = controlPlane.dashboard();
    assert.equal(beforeApproval.summary.approvals, 1);
    assert.equal(beforeApproval.userActions[0]?.category, "human_review");
    assert.equal(beforeApproval.userActions[0]?.priority, 110);

    const toolPacket = controlPlane.decisionPacket(item.id);
    assert.ok(toolPacket);
    assert.deepEqual(toolPacket.requestedDecision.options, ["approve", "reject"]);
    controlPlane.denyToolCall({
      id: item.id,
      callHash,
      toolName: "workspace.write_file",
      packetHash: toolPacket.binding.packetHash,
      note: "The exact write is not allowed for this work item.",
      actor: "human:test",
      idempotencyKey: "tool-review:deny",
    });
    const afterApproval = controlPlane.dashboard();
    assert.equal(afterApproval.summary.approvals, 0);
    assert.notEqual(afterApproval.userActions[0]?.category, "human_review");
    assert.equal(controlPlane.get(item.id).status, "canceled");
    assert.equal(controlPlane.listPendingToolCalls(item.id)[0]?.status, "denied");

    const malformedItem = controlPlane.intake({
      title: "Reject malformed tool arguments",
      summary: "Malformed arguments cannot enter the approval queue.",
      actor: "human:test",
      idempotencyKey: "tool-review:malformed-intake",
    });
    controlPlane.triage({
      id: malformedItem.id,
      ownerRole: "operator",
      executionTarget: "local",
      actor: "human:test",
      idempotencyKey: "tool-review:malformed-triage",
    });
    const malformedClaim = controlPlane.claim({
      id: malformedItem.id,
      actor: "runner:test",
      idempotencyKey: "tool-review:malformed-claim",
    });
    assert.throws(
      () =>
        controlPlane.recordPendingToolCall({
          id: malformedItem.id,
          runId: malformedClaim.runId,
          attemptId: malformedClaim.attemptId,
          leaseId: malformedClaim.leaseId,
          generation: malformedClaim.generation,
          callHash: "f".repeat(64),
          toolName: "workspace.write_file",
          arguments: { unparsed: "{\"path\":" },
          createdAt: new Date().toISOString(),
          actor: "runner:test",
          idempotencyKey: "tool-review:malformed-pending",
        }),
      /fully parsed/u,
    );
    controlPlane.failRun({
      id: malformedItem.id,
      ...runFence(malformedClaim),
      errorCode: "TOOL_ARGUMENTS_INVALID",
      errorMessage: "Tool arguments were incomplete.",
      actor: "runner:test",
      idempotencyKey: "tool-review:malformed-fail",
    });
    const unapprovable = controlPlane.dashboard();
    assert.equal(unapprovable.summary.approvals, 0);
    assert.notEqual(
      unapprovable.userActions.find(
        ({ workItemId }) => workItemId === malformedItem.id,
      )?.category,
      "human_review",
    );
  } finally {
    database.close();
  }
});

test("dashboard primary human decision is independent of the newest-work page", () => {
  const { database, controlPlane } = fixture();
  try {
    const review = controlPlane.intake({
      title: "Older decision",
      summary: "This decision must not disappear behind newer work.",
      actor: "human:test",
      idempotencyKey: "global-decision:intake",
    });
    controlPlane.triage({
      id: review.id,
      ownerRole: "operator",
      executionTarget: "local",
      actor: "human:test",
      idempotencyKey: "global-decision:triage",
    });
    const claim = controlPlane.claim({
      id: review.id,
      actor: "runner:test",
      idempotencyKey: "global-decision:claim",
    });
    controlPlane.submitArtifact({
      id: review.id,
      ...runFence(claim),
      content: JSON.stringify({
        summary: "Review me even when I am not on the newest page.",
        deliverable: "Bounded artifact",
        checks: [],
        risks: [],
        nextActions: [],
        confidence: "medium",
      }),
      actor: "runner:test",
      idempotencyKey: "global-decision:submit",
    });
    const newer = controlPlane.intake({
      title: "Newer agent work",
      summary: "This item occupies the one-row newest page.",
      actor: "human:test",
      idempotencyKey: "global-decision:newer",
    });

    const projection = controlPlane.dashboard({ limit: 1 });
    assert.equal(projection.summary.humanDecisions, 1);
    assert.equal(projection.summary.agentActions, 1);
    assert.equal(
      projection.attention.primaryDecision?.workItemId,
      review.id,
    );
    assert.deepEqual(
      new Set(projection.workItems.map(({ id }) => id)),
      new Set([review.id, newer.id]),
    );
  } finally {
    database.close();
  }
});

test("changes requested retain the human review note", () => {
  const { database, controlPlane } = fixture();
  try {
    const item = controlPlane.intake({
      title: "Revise one artifact",
      summary: "The reviewer must be able to explain the requested change.",
      actor: "human:test",
      idempotencyKey: "review-note:intake",
    });
    controlPlane.triage({
      id: item.id,
      ownerRole: "operator",
      executionTarget: "local",
      actor: "human:test",
      idempotencyKey: "review-note:triage",
    });
    const claim = controlPlane.claim({
      id: item.id,
      actor: "runner:test",
      idempotencyKey: "review-note:claim",
    });
    const submission = controlPlane.submitArtifact({
      id: item.id,
      ...runFence(claim),
      content: '{"summary":"draft"}',
      actor: "runner:test",
      idempotencyKey: "review-note:submit",
    });
    controlPlane.decide({
      id: item.id,
      decision: "changes_requested",
      artifactHash: submission.sha256,
      packetHash: currentPacketHash(controlPlane, item.id),
      note: "검증 결과를 첨부하고 다시 제출하세요.",
      actor: "human:test",
      idempotencyKey: "review-note:decision",
    });
    const decision = controlPlane.latestArtifactDecision(item.id);
    assert.equal(decision?.decision, "changes_requested");
    assert.equal(
      decision?.note,
      "검증 결과를 첨부하고 다시 제출하세요.",
    );
  } finally {
    database.close();
  }
});

test("decision packets keep model claims unverified and reject stale or non-human decisions", () => {
  const { database, controlPlane } = fixture();
  try {
    const item = controlPlane.intake({
      title: "Review a claimed result",
      summary: "Separate producer claims from executable evidence.",
      actor: "human:test",
      idempotencyKey: "packet:intake",
    });
    controlPlane.triage({
      id: item.id,
      ownerRole: "operator",
      executionTarget: "local",
      actor: "human:test",
      idempotencyKey: "packet:triage",
    });
    const firstClaim = controlPlane.claim({
      id: item.id,
      actor: "runner:test",
      idempotencyKey: "packet:claim:1",
    });
    const content = JSON.stringify({
      apiVersion: "chartermesh.dev/structured-artifact/v1alpha1",
      summary: "A bounded result was produced.",
      deliverable: "Synthetic deliverable",
      checks: ["All tests passed."],
      risks: ["The check is only producer-reported."],
      nextActions: ["Review the evidence provenance."],
      confidence: "high",
    });
    const firstArtifact = controlPlane.submitArtifact({
      id: item.id,
      ...runFence(firstClaim),
      content,
      actor: "runner:test",
      idempotencyKey: "packet:submit:1",
    });
    const firstPacket = controlPlane.decisionPacket(item.id);
    assert.ok(firstPacket);
    assert.equal(firstPacket.kind, "artifact_review");
    assert.equal(firstPacket.producerReport?.summary, "A bounded result was produced.");
    assert.match(firstArtifact.producerReportHash ?? "", /^[a-f0-9]{64}$/u);
    assert.equal(
      controlPlane.latestArtifact(item.id)?.producerReportHash,
      firstArtifact.producerReportHash,
    );
    assert.equal(
      firstPacket.binding.producerReportHash,
      firstArtifact.producerReportHash,
    );
    assert.deepEqual(
      firstPacket.evidence
        .filter(({ source }) => source === "model_reported")
        .map(({ status }) => status),
      ["claimed"],
    );
    assert.equal(
      firstPacket.evidence.some(
        ({ source, status }) =>
          source === "model_reported" && status === "verified",
      ),
      false,
    );
    assert.equal(
      firstPacket.exceptions.some(
        ({ code }) => code === "MODEL_REPORTED_ONLY",
      ),
      true,
    );
    assert.throws(
      () =>
        controlPlane.triage({
          id: item.id,
          ownerRole: "operator",
          executionTarget: "local",
          actor: "human:test",
          idempotencyKey: "packet:bypass-triage",
        }),
      /Only requested, ready, or change-requested/u,
    );
    assert.throws(
      () =>
        controlPlane.resume({
          id: item.id,
          actor: "human:test",
          idempotencyKey: "packet:bypass-resume",
        }),
      /dedicated command/u,
    );
    assert.throws(
      () =>
        controlPlane.decide({
          id: item.id,
          decision: "approve",
          artifactHash: firstArtifact.sha256,
          packetHash: firstPacket.binding.packetHash,
          note: "A role cannot approve its own report.",
          actor: "role:operator",
          idempotencyKey: "packet:role-decision",
        }),
      /human actor/u,
    );
    controlPlane.decide({
      id: item.id,
      decision: "changes_requested",
      artifactHash: firstArtifact.sha256,
      packetHash: firstPacket.binding.packetHash,
      note: "Add executable evidence and resubmit the same bounded report.",
      actor: "human:test",
      idempotencyKey: "packet:changes",
    });
    const secondClaim = controlPlane.claim({
      id: item.id,
      actor: "runner:test",
      idempotencyKey: "packet:claim:2",
    });
    const secondArtifact = controlPlane.submitArtifact({
      id: item.id,
      ...runFence(secondClaim),
      content,
      actor: "runner:test",
      idempotencyKey: "packet:submit:2",
    });
    const secondPacket = controlPlane.decisionPacket(item.id);
    assert.ok(secondPacket);
    assert.equal(secondArtifact.sha256, firstArtifact.sha256);
    assert.notEqual(
      secondPacket.binding.packetHash,
      firstPacket.binding.packetHash,
    );
    assert.throws(
      () =>
        controlPlane.decide({
          id: item.id,
          decision: "approve",
          artifactHash: secondArtifact.sha256,
          packetHash: firstPacket.binding.packetHash,
          note: "This packet is stale.",
          actor: "human:test",
          idempotencyKey: "packet:stale-decision",
        }),
      /packet does not match/u,
    );
  } finally {
    database.close();
  }
});

test("artifact producer sidecars bind real deliverables while keeping reported checks as claims", () => {
  const { database, controlPlane } = fixture();
  try {
    const item = controlPlane.intake({
      title: "Review a rendered deliverable",
      summary: "Keep the immutable deliverable separate from its bounded report.",
      actor: "human:test",
      idempotencyKey: "sidecar:intake",
    });
    controlPlane.triage({
      id: item.id,
      ownerRole: "operator",
      executionTarget: "local",
      actor: "human:test",
      idempotencyKey: "sidecar:triage",
    });
    const firstClaim = controlPlane.claim({
      id: item.id,
      actor: "runner:test",
      idempotencyKey: "sidecar:claim:1",
    });
    const deliverable = "<html><body>release notes</body></html>";
    const report = {
      apiVersion: "chartermesh.dev/artifact-producer-report/v1alpha1" as const,
      source: "runtime_compiled" as const,
      summary: "Release notes were rendered.",
      deliverable: "HTML release notes",
      reportedChecks: ["The runtime compiler produced bounded HTML."],
      reportedRisks: [],
      nextActions: [],
      confidence: "high" as const,
    };
    const firstArtifact = controlPlane.submitArtifact({
      id: item.id,
      ...runFence(firstClaim),
      content: deliverable,
      mediaType: "text/html",
      producerReport: report,
      actor: "runner:test",
      idempotencyKey: "sidecar:submit:1",
    });
    const firstPacket = controlPlane.decisionPacket(item.id);
    assert.ok(firstPacket);
    assert.equal(firstPacket.apiVersion, "chartermesh.dev/decision-packet/v1alpha2");
    assert.equal(firstPacket.subject.kind, "artifact");
    assert.equal(firstPacket.producerReport?.source, "runtime_compiled");
    assert.equal(
      firstPacket.binding.producerReportHash,
      firstArtifact.producerReportHash,
    );
    const replayRow = database
      .prepare(
        "SELECT response_json FROM command_results WHERE idempotency_key = ?",
      )
      .get("sidecar:submit:1") as { response_json: string };
    const legacyReplay = JSON.parse(replayRow.response_json) as Record<
      string,
      unknown
    >;
    delete legacyReplay.producerReportHash;
    database
      .prepare(
        "UPDATE command_results SET response_json = ? WHERE idempotency_key = ?",
      )
      .run(JSON.stringify(legacyReplay), "sidecar:submit:1");
    const replayed = controlPlane.submitArtifact({
      id: item.id,
      ...runFence(firstClaim),
      content: deliverable,
      mediaType: "text/html",
      producerReport: report,
      actor: "runner:test",
      idempotencyKey: "sidecar:submit:1",
    });
    assert.equal(replayed.producerReportHash, null);
    assert.equal(
      firstPacket.exceptions.some(
        ({ code }) => code === "ARTIFACT_UNSTRUCTURED",
      ),
      false,
    );
    assert.equal(
      firstPacket.exceptions.some(({ code }) => code === "MODEL_REPORTED_ONLY"),
      true,
    );
    assert.equal(
      firstPacket.evidence.some(
        ({ source, status }) =>
          source === "model_reported" && status === "claimed",
      ),
      true,
    );
    const reviewView = projectDecisionReviewView(firstPacket);
    assert.equal(
      reviewView.apiVersion,
      "chartermesh.dev/decision-review-view/v1alpha1",
    );
    assert.equal(reviewView.result?.summary, report.summary);
    assert.equal(
      reviewView.binding.packetHash,
      firstPacket.binding.packetHash,
    );
    const stored = controlPlane.latestArtifact(item.id);
    assert.equal(stored?.content, deliverable);
    assert.deepEqual(stored?.producerReport, report);

    controlPlane.decide({
      id: item.id,
      decision: "changes_requested",
      artifactHash: firstArtifact.sha256,
      packetHash: firstPacket.binding.packetHash,
      note: "Clarify the report while preserving the exact deliverable.",
      actor: "human:test",
      idempotencyKey: "sidecar:changes",
    });
    const secondClaim = controlPlane.claim({
      id: item.id,
      actor: "runner:test",
      idempotencyKey: "sidecar:claim:2",
    });
    const secondArtifact = controlPlane.submitArtifact({
      id: item.id,
      ...runFence(secondClaim),
      content: deliverable,
      mediaType: "text/html",
      producerReport: {
        ...report,
        summary: "Release notes were rendered and bounded to this report.",
      },
      actor: "runner:test",
      idempotencyKey: "sidecar:submit:2",
    });
    const secondPacket = controlPlane.decisionPacket(item.id);
    assert.ok(secondPacket);
    assert.equal(secondArtifact.sha256, firstArtifact.sha256);
    assert.notEqual(
      secondArtifact.producerReportHash,
      firstArtifact.producerReportHash,
    );
    assert.notEqual(
      secondPacket.binding.packetHash,
      firstPacket.binding.packetHash,
    );
    assert.throws(
      () =>
        controlPlane.decide({
          id: item.id,
          decision: "approve",
          artifactHash: secondArtifact.sha256,
          packetHash: firstPacket.binding.packetHash,
          note: "A report-bound stale packet cannot be reused.",
          actor: "human:test",
          idempotencyKey: "sidecar:stale",
        }),
      /packet does not match/u,
    );
  } finally {
    database.close();
  }
});

test("a projected v1alpha2 packet is persisted before approving a migrated active review", () => {
  const { database, controlPlane } = fixture();
  try {
    const item = controlPlane.intake({
      title: "Migrate an active review",
      summary: "Persist the current packet before recording its approval.",
      actor: "human:test",
      idempotencyKey: "packet-migration:intake",
    });
    controlPlane.triage({
      id: item.id,
      ownerRole: "operator",
      executionTarget: "local",
      actor: "human:test",
      idempotencyKey: "packet-migration:triage",
    });
    const claim = controlPlane.claim({
      id: item.id,
      actor: "runner:test",
      idempotencyKey: "packet-migration:claim",
    });
    const artifact = controlPlane.submitArtifact({
      id: item.id,
      ...runFence(claim),
      content: "migrated review artifact",
      actor: "runner:test",
      idempotencyKey: "packet-migration:submit",
    });
    const current = controlPlane.decisionPacket(item.id);
    assert.ok(current);
    const legacy = structuredClone(current) as unknown as Record<string, unknown>;
    legacy.apiVersion = "chartermesh.dev/decision-packet/v1alpha1";
    const legacyBinding = legacy.binding as Record<string, unknown>;
    legacyBinding.projectionVersion = "v1alpha1";
    delete legacyBinding.producerReportHash;
    const legacyHash = "e".repeat(64);
    legacyBinding.packetHash = legacyHash;
    database
      .prepare(`
        UPDATE decision_packets
        SET packet_hash = ?, packet_json = ?
        WHERE work_item_id = ? AND superseded_at IS NULL
      `)
      .run(legacyHash, JSON.stringify(legacy), item.id);

    const projected = controlPlane.decisionPacket(item.id);
    assert.ok(projected);
    assert.equal(projected.apiVersion, "chartermesh.dev/decision-packet/v1alpha2");
    assert.notEqual(projected.binding.packetHash, legacyHash);
    controlPlane.decide({
      id: item.id,
      decision: "approve",
      artifactHash: artifact.sha256,
      packetHash: projected.binding.packetHash,
      note: "Approve only after the migrated packet is durably recorded.",
      actor: "human:test",
      idempotencyKey: "packet-migration:approve",
    });
    const persisted = database
      .prepare(`
        SELECT COUNT(*) AS count
        FROM decision_packets
        WHERE work_item_id = ? AND packet_hash = ?
      `)
      .get(item.id, projected.binding.packetHash) as { count: number };
    assert.equal(Number(persisted.count), 1);
    const approval = database
      .prepare(`
        SELECT packet_hash
        FROM approvals
        WHERE work_item_id = ?
        ORDER BY created_at DESC LIMIT 1
      `)
      .get(item.id) as { packet_hash: string };
    assert.equal(approval.packet_hash, projected.binding.packetHash);
  } finally {
    database.close();
  }
});

test("artifact and producer-report tampering fail closed before review", () => {
  const prepare = (suffix: string) => {
    const value = fixture();
    const item = value.controlPlane.intake({
      title: `Integrity ${suffix}`,
      summary: "Review only hash-matching immutable evidence.",
      actor: "human:test",
      idempotencyKey: `integrity:${suffix}:intake`,
    });
    value.controlPlane.triage({
      id: item.id,
      ownerRole: "operator",
      executionTarget: "local",
      actor: "human:test",
      idempotencyKey: `integrity:${suffix}:triage`,
    });
    const claim = value.controlPlane.claim({
      id: item.id,
      actor: "runner:test",
      idempotencyKey: `integrity:${suffix}:claim`,
    });
    const artifact = value.controlPlane.submitArtifact({
      id: item.id,
      ...runFence(claim),
      content: "immutable artifact bytes",
      producerReport: {
        apiVersion: "chartermesh.dev/artifact-producer-report/v1alpha1",
        source: "runtime_compiled",
        summary: "Bounded integrity fixture.",
        deliverable: "immutable artifact bytes",
        reportedChecks: [],
        reportedRisks: [],
        nextActions: [],
        confidence: "medium",
      },
      actor: "runner:test",
      idempotencyKey: `integrity:${suffix}:submit`,
    });
    return { ...value, item, artifact };
  };

  const blob = prepare("blob");
  try {
    writeFileSync(
      join(blob.directory, "artifacts", `${blob.artifact.sha256}.txt`),
      "tampered artifact bytes",
      "utf8",
    );
    assert.throws(
      () => blob.controlPlane.latestArtifact(blob.item.id),
      /ARTIFACT_INTEGRITY_MISMATCH/u,
    );
    assert.throws(
      () => blob.controlPlane.decisionPacket(blob.item.id),
      /ARTIFACT_INTEGRITY_MISMATCH/u,
    );
  } finally {
    blob.database.close();
  }

  const report = prepare("report");
  try {
    report.database
      .prepare(`
        UPDATE artifacts
        SET producer_report_json = ?
        WHERE work_item_id = ?
      `)
      .run(
        JSON.stringify({
          apiVersion: "chartermesh.dev/artifact-producer-report/v1alpha1",
          source: "runtime_compiled",
          summary: "Tampered report.",
          deliverable: "immutable artifact bytes",
          reportedChecks: [],
          reportedRisks: [],
          nextActions: [],
          confidence: "medium",
        }),
        report.item.id,
      );
    assert.throws(
      () => report.controlPlane.latestArtifact(report.item.id),
      /ARTIFACT_PRODUCER_REPORT_HASH_MISMATCH/u,
    );
    assert.throws(
      () => report.controlPlane.decisionPacket(report.item.id),
      /ARTIFACT_PRODUCER_REPORT_HASH_MISMATCH/u,
    );
  } finally {
    report.database.close();
  }

  const media = prepare("media");
  try {
    const before = media.controlPlane.decisionPacket(media.item.id);
    assert.ok(before);
    media.database
      .prepare("UPDATE artifacts SET media_type = ? WHERE work_item_id = ?")
      .run("application/octet-stream", media.item.id);
    const after = media.controlPlane.decisionPacket(media.item.id);
    assert.ok(after);
    assert.notEqual(after.binding.subjectHash, before.binding.subjectHash);
    assert.notEqual(after.binding.packetHash, before.binding.packetHash);
    assert.throws(
      () =>
        media.controlPlane.decide({
          id: media.item.id,
          decision: "approve",
          artifactHash: media.artifact.sha256,
          packetHash: before.binding.packetHash,
          note: "A stale media-type binding must not approve.",
          actor: "human:test",
          idempotencyKey: "integrity:media:stale-approve",
        }),
      /packet does not match/u,
    );
  } finally {
    media.database.close();
  }
});

test("idempotency replays the original response and rejects command reuse", () => {
  const { database, controlPlane } = fixture();
  try {
    const input = {
      title: "Idempotent request",
      summary: "Create once.",
      actor: "human:test",
      idempotencyKey: "same-key",
    };
    const first = controlPlane.intake(input);
    const replay = controlPlane.intake({
      idempotencyKey: input.idempotencyKey,
      actor: input.actor,
      summary: input.summary,
      title: input.title,
    });
    assert.deepEqual(replay, first);
    assert.equal(controlPlane.list().length, 1);
    const stored = database
      .prepare(
        "SELECT request_hash FROM command_results WHERE idempotency_key = ?",
      )
      .get(input.idempotencyKey) as { request_hash: string };
    assert.match(stored.request_hash, /^[a-f0-9]{64}$/u);
    assert.throws(
      () =>
        controlPlane.intake({
          ...input,
          summary: "A changed payload must never replay the first response.",
        }),
      /different request input/u,
    );
    assert.throws(
      () =>
        controlPlane.triage({
          id: first.id,
          ownerRole: "operator",
          executionTarget: "simulated-local",
          actor: "human:test",
          idempotencyKey: "same-key",
        }),
      /another command/u,
    );
  } finally {
    database.close();
  }
});

test("idempotency replay cannot transfer a claim or heartbeat across actors", () => {
  const { database, controlPlane } = fixture();
  try {
    const item = controlPlane.intake({
      title: "Actor-bound lease",
      summary: "A cached lease response belongs only to the original actor.",
      actor: "human:test",
      idempotencyKey: "actor-bound:intake",
    });
    controlPlane.triage({
      id: item.id,
      ownerRole: "operator",
      executionTarget: "local",
      actor: "human:test",
      idempotencyKey: "actor-bound:triage",
    });
    const claim = controlPlane.claim({
      id: item.id,
      actor: "runner:one",
      idempotencyKey: "actor-bound:claim",
    });
    assert.throws(
      () =>
        controlPlane.claim({
          id: item.id,
          actor: "runner:two",
          idempotencyKey: "actor-bound:claim",
        }),
      /different request input/u,
    );

    const heartbeatInput = {
      id: item.id,
      ...runFence(claim),
      actor: "runner:one",
      idempotencyKey: "actor-bound:heartbeat",
    };
    const heartbeat = controlPlane.heartbeat(heartbeatInput);
    assert.equal(heartbeat.leaseId, claim.leaseId);
    assert.throws(
      () =>
        controlPlane.heartbeat({
          ...heartbeatInput,
          actor: "runner:two",
        }),
      /different request input/u,
    );
  } finally {
    database.close();
  }
});

test("human-controlled global pause blocks only new run claims", () => {
  const { database, controlPlane } = fixture();
  try {
    const item = controlPlane.intake({
      title: "Pause-aware work",
      summary: "The item remains ready while run starts are paused.",
      actor: "human:test",
      idempotencyKey: "pause:intake",
    });
    controlPlane.triage({
      id: item.id,
      ownerRole: "operator",
      executionTarget: "local",
      actor: "human:test",
      idempotencyKey: "pause:triage",
    });
    const paused = controlPlane.pauseOperations({
      reason: "Operator requested a quiet window.",
      actor: "human:test",
      idempotencyKey: "pause:start",
    });
    assert.equal(paused.paused, true);
    assert.equal(controlPlane.get(item.id).status, "ready");
    assert.throws(
      () =>
        controlPlane.claim({
          id: item.id,
          actor: "role:operator",
          idempotencyKey: "pause:blocked-claim",
        }),
      /OPERATIONS_PAUSED/u,
    );
    assert.throws(
      () =>
        controlPlane.resumeOperations({
          actor: "role:operator",
          idempotencyKey: "pause:invalid-resume",
        }),
      /REQUIRES_HUMAN/u,
    );
    assert.equal(
      controlPlane.resumeOperations({
        actor: "human:test",
        idempotencyKey: "pause:resume",
      }).paused,
      false,
    );
    assert.equal(
      controlPlane.claim({
        id: item.id,
        actor: "role:operator",
        idempotencyKey: "pause:claim",
      }).generation,
      1,
    );
  } finally {
    database.close();
  }
});

test("artifact evidence is fenced by run generation and exact hash", () => {
  const { database, controlPlane } = fixture();
  try {
    const item = controlPlane.intake({
      title: "Generation fencing",
      summary: "Only the active run may submit review evidence.",
      actor: "human:test",
      idempotencyKey: "fence:intake",
    });
    controlPlane.triage({
      id: item.id,
      ownerRole: "operator",
      executionTarget: "simulated-local",
      actor: "human:test",
      idempotencyKey: "fence:triage",
    });
    const claim = controlPlane.claim({
      id: item.id,
      actor: "runner:test",
      idempotencyKey: "fence:claim",
    });
    assert.throws(
      () =>
        controlPlane.wait({
          id: item.id,
          condition: {
            type: "manual_resume",
            reason: "An active worker cannot discard its lease credentials.",
          },
          actor: "runner:test",
          idempotencyKey: "fence:unfenced-wait",
        }),
      /RUN_OWNERSHIP_FENCE_REQUIRED/u,
    );
    assert.throws(
      () =>
        controlPlane.submitArtifact({
          id: item.id,
          ...runFence(claim),
          content: "Stale result",
          generation: claim.generation + 1,
          actor: "runner:test",
          idempotencyKey: "fence:stale-submit",
        }),
      /RUN_OWNERSHIP_FENCE_MISMATCH/u,
    );
    const submitted = controlPlane.submitArtifact({
      id: item.id,
      ...runFence(claim),
      content: "Current result",
      actor: "runner:test",
      idempotencyKey: "fence:submit",
    });
    assert.throws(
      () =>
        controlPlane.decide({
          id: item.id,
          decision: "approve",
          artifactHash: "0".repeat(64),
          packetHash: currentPacketHash(controlPlane, item.id),
          note: "Wrong evidence.",
          actor: "human:test",
          idempotencyKey: "fence:wrong-review",
        }),
      /Review hash does not match/u,
    );
    const approved = controlPlane.decide({
      id: item.id,
      decision: "approve",
      artifactHash: submitted.sha256,
      packetHash: currentPacketHash(controlPlane, item.id),
      note: "Exact artifact reviewed.",
      actor: "human:test",
      idempotencyKey: "fence:review",
    });
    assert.equal(approved.status, "approved");
  } finally {
    database.close();
  }
});

test("artifact byte limits are enforced before evidence is written", () => {
  const directory = mkdtempSync(join(tmpdir(), "chartermesh-artifact-limit-"));
  const database = openControlPlaneDatabase(join(directory, "state.db"));
  const controlPlane = new ControlPlane(database, join(directory, "artifacts"), {
    budgets: {
      monthlyCostLimitUsd: 10,
      maxConcurrentRuns: 1,
      maxDailyModelStarts: 10,
      maxArtifactBytes: 8,
      maxWorkItemArtifactBytes: 12,
    },
  });
  try {
    const item = controlPlane.intake({
      title: "Bounded artifact",
      summary: "Reject oversized evidence.",
      actor: "human:test",
      idempotencyKey: "artifact-limit:intake",
    });
    controlPlane.triage({
      id: item.id,
      ownerRole: "operator",
      executionTarget: "local",
      actor: "human:test",
      idempotencyKey: "artifact-limit:triage",
    });
    const firstClaim = controlPlane.claim({
      id: item.id,
      actor: "runner:test",
      idempotencyKey: "artifact-limit:first-claim",
    });
    assert.throws(
      () =>
        controlPlane.submitArtifact({
          id: item.id,
          ...runFence(firstClaim),
          content: "123456789",
          actor: "runner:test",
          idempotencyKey: "artifact-limit:oversized",
        }),
      /ARTIFACT_SIZE_LIMIT_EXCEEDED/u,
    );
    const first = controlPlane.submitArtifact({
      id: item.id,
      ...runFence(firstClaim),
      content: "12345678",
      actor: "runner:test",
      idempotencyKey: "artifact-limit:first-submit",
    });
    controlPlane.decide({
      id: item.id,
      decision: "changes_requested",
      artifactHash: first.sha256,
      packetHash: currentPacketHash(controlPlane, item.id),
      note: "Submit a revision.",
      actor: "human:test",
      idempotencyKey: "artifact-limit:changes",
    });
    const secondClaim = controlPlane.claim({
      id: item.id,
      actor: "runner:test",
      idempotencyKey: "artifact-limit:second-claim",
    });
    assert.throws(
      () =>
        controlPlane.submitArtifact({
          id: item.id,
          ...runFence(secondClaim),
          content: "12345",
          actor: "runner:test",
          idempotencyKey: "artifact-limit:work-total",
        }),
      /WORK_ITEM_ARTIFACT_BUDGET_EXCEEDED/u,
    );
  } finally {
    database.close();
  }
});

test("failed runs are retryable with a new fenced generation", () => {
  const { database, controlPlane } = fixture();
  try {
    const item = controlPlane.intake({
      title: "Retry a failed model call",
      summary: "Preserve failure evidence and create a new generation.",
      actor: "human:test",
      idempotencyKey: "retry:intake",
    });
    controlPlane.triage({
      id: item.id,
      ownerRole: "operator",
      executionTarget: "local",
      actor: "human:test",
      idempotencyKey: "retry:triage",
    });
    const first = controlPlane.claim({
      id: item.id,
      actor: "runner:test",
      idempotencyKey: "retry:claim:1",
    });
    controlPlane.failRun({
      id: item.id,
      ...runFence(first),
      errorCode: "MODEL_INVOCATION_FAILED",
      errorMessage: "Synthetic model failure.",
      actor: "runner:test",
      idempotencyKey: "retry:fail",
    });
    assert.equal(controlPlane.get(item.id).status, "failed");
    const failedProjection = controlPlane.dashboard();
    assert.equal(failedProjection.summary.actionable, 0);
    assert.equal(failedProjection.summary.approvals, 0);
    assert.equal(failedProjection.userActions[0]?.category, "retry");
    assert.equal(failedProjection.userActions[0]?.actionable, false);
    controlPlane.retry({
      id: item.id,
      actor: "human:test",
      idempotencyKey: "retry:ready",
    });
    const second = controlPlane.claim({
      id: item.id,
      actor: "runner:test",
      idempotencyKey: "retry:claim:2",
    });
    assert.equal(second.generation, 2);
  } finally {
    database.close();
  }
});

test("unknown tool outcomes require explicit human acknowledgement before retry", () => {
  const { database, controlPlane } = fixture();
  try {
    const item = controlPlane.intake({
      title: "Inspect an uncertain tool outcome",
      summary: "Do not silently repeat a tool after its evidence sink failed.",
      actor: "human:test",
      idempotencyKey: "unknown-tool:intake",
    });
    controlPlane.triage({
      id: item.id,
      ownerRole: "operator",
      executionTarget: "local",
      actor: "human:test",
      idempotencyKey: "unknown-tool:triage",
    });
    const claim = controlPlane.claim({
      id: item.id,
      actor: "runner:test",
      idempotencyKey: "unknown-tool:claim",
    });
    controlPlane.prepareToolEvidence({
      id: item.id,
      runId: claim.runId,
      attemptId: claim.attemptId,
      leaseId: claim.leaseId,
      generation: claim.generation,
      callHash: "a".repeat(64),
      toolName: "workspace.write_file",
      inputHash: "b".repeat(64),
      actor: "runner:test",
    });
    const failed = controlPlane.failRun({
      id: item.id,
      ...runFence(claim),
      errorCode: "TOOL_OUTCOME_UNKNOWN",
      errorMessage: "The tool returned before evidence was committed.",
      actor: "runner:test",
      idempotencyKey: "unknown-tool:fail",
    });
    assert.match(failed.nextAction, /explicitly acknowledge/u);
    assert.throws(
      () =>
        controlPlane.retry({
          id: item.id,
          actor: "human:test",
          idempotencyKey: "unknown-tool:retry-without-ack",
        }),
      /TOOL_OUTCOME_UNKNOWN/u,
    );
    assert.throws(
      () =>
        controlPlane.retry({
          id: item.id,
          actor: "role:model",
          acknowledgeUnknownToolOutcome: true,
          idempotencyKey: "unknown-tool:model-ack",
        }),
      /TOOL_OUTCOME_UNKNOWN/u,
    );
    assert.equal(
      controlPlane.retry({
        id: item.id,
        actor: "human:test",
        acknowledgeUnknownToolOutcome: true,
        idempotencyKey: "unknown-tool:human-ack",
      }).status,
      "ready",
    );
  } finally {
    database.close();
  }
});

test("human acknowledgement retires an uncertain pending call without replay", () => {
  const { database, controlPlane } = fixture();
  try {
    const item = controlPlane.intake({
      title: "Retire an uncertain approved write",
      summary: "A human-inspected unknown outcome must not remain retryable.",
      actor: "human:test",
      idempotencyKey: "unknown-pending:intake",
    });
    controlPlane.triage({
      id: item.id,
      ownerRole: "operator",
      executionTarget: "local",
      actor: "human:test",
      idempotencyKey: "unknown-pending:triage",
    });
    const approvalClaim = controlPlane.claim({
      id: item.id,
      actor: "runner:test",
      idempotencyKey: "unknown-pending:approval-claim",
    });
    const callHash = "d".repeat(64);
    controlPlane.recordPendingToolCall({
      id: item.id,
      ...runFence(approvalClaim),
      callHash,
      toolName: "workspace.write_file",
      arguments: {
        path: "result.txt",
        content: "uncertain\n",
        beforeSha256: null,
      },
      createdAt: new Date().toISOString(),
      actor: "runner:test",
      idempotencyKey: "unknown-pending:record",
    });
    controlPlane.approveToolCall({
      id: item.id,
      callHash,
      toolName: "workspace.write_file",
      packetHash: currentPacketHash(controlPlane, item.id),
      actor: "human:test",
      note: "Approve this exact content-addressed write.",
      idempotencyKey: "unknown-pending:approve",
    });
    const executionClaim = controlPlane.claim({
      id: item.id,
      actor: "runner:test",
      idempotencyKey: "unknown-pending:execution-claim",
    });
    const reservation = controlPlane.reservePendingToolExecution({
      id: item.id,
      ...runFence(executionClaim),
      callHash,
      actor: "runner:test",
      idempotencyKey: "unknown-pending:reserve",
    });
    assert.equal(reservation.disposition, "reserved");
    assert.ok(reservation.pending.reservation);
    controlPlane.markPendingToolOutcomeUnknown({
      id: item.id,
      ...runFence(executionClaim),
      callHash,
      previousReservationId: reservation.pending.reservation.id,
      message: "The atomic effect may have committed before evidence failed.",
      actor: "runner:test",
      idempotencyKey: "unknown-pending:mark-unknown",
    });
    assert.equal(
      controlPlane.listPendingToolCalls(item.id)[0]?.status,
      "outcome_unknown",
    );

    assert.equal(
      controlPlane.retry({
        id: item.id,
        actor: "human:test",
        acknowledgeUnknownToolOutcome: true,
        idempotencyKey: "unknown-pending:acknowledge",
      }).status,
      "ready",
    );
    assert.equal(
      controlPlane.listPendingToolCalls(item.id)[0]?.status,
      "outcome_acknowledged",
    );
    assert.equal(
      (
        database.prepare(`
          SELECT COUNT(*) AS count
          FROM pending_tool_calls
          WHERE work_item_id = ? AND status = 'outcome_unknown'
        `).get(item.id) as { count: number }
      ).count,
      0,
    );

    const retryClaim = controlPlane.claim({
      id: item.id,
      actor: "runner:test",
      idempotencyKey: "unknown-pending:retry-claim",
    });
    assert.throws(
      () =>
        controlPlane.recordPendingToolCall({
          id: item.id,
          ...runFence(retryClaim),
          callHash,
          toolName: "workspace.write_file",
          arguments: {
            path: "result.txt",
            content: "uncertain\n",
            beforeSha256: null,
          },
          createdAt: new Date().toISOString(),
          actor: "runner:test",
          idempotencyKey: "unknown-pending:record-same-call",
        }),
      /TOOL_OUTCOME_ACKNOWLEDGED/u,
    );
  } finally {
    database.close();
  }
});

test("expired leases recover to a visible failed state", () => {
  const { database, controlPlane } = fixture();
  try {
    const item = controlPlane.intake({
      title: "Recover abandoned work",
      summary: "An expired worker must not leave work in progress forever.",
      actor: "human:test",
      idempotencyKey: "lease:intake",
    });
    controlPlane.triage({
      id: item.id,
      ownerRole: "operator",
      executionTarget: "local",
      actor: "human:test",
      idempotencyKey: "lease:triage",
    });
    controlPlane.claim({
      id: item.id,
      actor: "runner:test",
      idempotencyKey: "lease:claim",
      leaseMinutes: -1,
    });
    assert.deepEqual(controlPlane.recoverExpiredLeases(), [item.id]);
    assert.equal(controlPlane.get(item.id).status, "failed");
  } finally {
    database.close();
  }
});

test("run starts enforce declared concurrency and daily budgets", () => {
  const directory = mkdtempSync(join(tmpdir(), "chartermesh-budget-"));
  const database = openControlPlaneDatabase(join(directory, "state.db"));
  const controlPlane = new ControlPlane(database, join(directory, "artifacts"), {
    budgets: {
      monthlyCostLimitUsd: 10,
      maxConcurrentRuns: 1,
      maxDailyModelStarts: 1,
    },
  });
  try {
    const items = ["first", "second"].map((name) => {
      const item = controlPlane.intake({
        title: name,
        summary: `Synthetic ${name} work.`,
        actor: "human:test",
        idempotencyKey: `budget:intake:${name}`,
      });
      controlPlane.triage({
        id: item.id,
        ownerRole: "operator",
        executionTarget: "local",
        actor: "human:test",
        idempotencyKey: `budget:triage:${name}`,
      });
      return item;
    });
    controlPlane.claim({
      id: items[0]!.id,
      actor: "runner:test",
      idempotencyKey: "budget:claim:first",
    });
    assert.throws(
      () =>
        controlPlane.claim({
          id: items[1]!.id,
          actor: "runner:test",
          idempotencyKey: "budget:claim:second",
        }),
      /BUDGET_CONCURRENT_RUNS_EXCEEDED/u,
    );
  } finally {
    database.close();
  }
});

test("block cost policy refuses later claims after unknown monthly usage", () => {
  const directory = mkdtempSync(join(tmpdir(), "chartermesh-cost-policy-"));
  const database = openControlPlaneDatabase(join(directory, "state.db"));
  const controlPlane = new ControlPlane(database, join(directory, "artifacts"), {
    budgets: {
      monthlyCostLimitUsd: 10,
      maxConcurrentRuns: 2,
      maxDailyModelStarts: 10,
      unknownCostPolicy: "block",
    },
  });
  try {
    const prepare = (name: string) => {
      const item = controlPlane.intake({
        title: name,
        summary: `Synthetic ${name} work.`,
        actor: "human:test",
        idempotencyKey: `cost-policy:intake:${name}`,
      });
      controlPlane.triage({
        id: item.id,
        ownerRole: "operator",
        executionTarget: "local",
        actor: "human:test",
        idempotencyKey: `cost-policy:triage:${name}`,
      });
      return item;
    };
    const first = prepare("first");
    const claim = controlPlane.claim({
      id: first.id,
      actor: "runner:test",
      idempotencyKey: "cost-policy:first-claim",
    });
    controlPlane.recordInvocation({
      attemptId: claim.attemptId,
      engineId: "unknown-cost-engine",
      modelId: "fixture",
      status: "failed",
      inputTokens: 10,
      outputTokens: 5,
      cost: null,
      measurementStatus: "unknown",
    });
    controlPlane.failRun({
      id: first.id,
      ...runFence(claim),
      errorCode: "FIXTURE_FAILURE",
      errorMessage: "Synthetic failure.",
      actor: "runner:test",
      idempotencyKey: "cost-policy:first-fail",
    });
    const second = prepare("second");
    assert.throws(
      () =>
        controlPlane.claim({
          id: second.id,
          actor: "runner:test",
          idempotencyKey: "cost-policy:second-claim",
        }),
      /BUDGET_UNKNOWN_COST_BLOCKED/u,
    );
  } finally {
    database.close();
  }
});

test("tool approval and execution evidence stay bound to exact hashes", async () => {
  const { directory, database, controlPlane } = fixture();
  try {
    const item = controlPlane.intake({
      title: "Approved tool call",
      summary: "Record only hashes and safe path evidence.",
      actor: "human:test",
      idempotencyKey: "tool:intake",
      requiredTools: ["workspace.write_file"],
    });
    assert.deepEqual(controlPlane.requiredTools(item.id), [
      "workspace.write_file",
    ]);
    controlPlane.triage({
      id: item.id,
      ownerRole: "operator",
      executionTarget: "local",
      actor: "human:test",
      idempotencyKey: "tool:triage",
    });
    const claim = controlPlane.claim({
      id: item.id,
      actor: "runner:test",
      idempotencyKey: "tool:claim",
    });
    const call = {
      id: "call-write-result",
      name: "workspace.write_file",
      arguments: {
        path: "src/result.ts",
        content: "export const result = true;\n",
        beforeSha256: null,
      },
    };
    const callHash = toolCallHash(item.id, call);
    controlPlane.recordPendingToolCall({
      id: item.id,
      runId: claim.runId,
      attemptId: claim.attemptId,
      leaseId: claim.leaseId,
      generation: claim.generation,
      callHash,
      toolName: "workspace.write_file",
      arguments: call.arguments,
      createdAt: new Date().toISOString(),
      actor: "runner:test",
      idempotencyKey: "tool:pending",
    });
    const waiting = controlPlane.get(item.id);
    assert.equal(waiting.status, "in_progress");
    assert.equal(waiting.availability, "approval_waiting");
    assert.equal(waiting.wait?.reference, callHash);
    assert.equal(
      (
        database
          .prepare("SELECT status FROM runs WHERE id = ?")
          .get(claim.runId) as { status: string }
      ).status,
      "waiting",
    );
    const pending = controlPlane.listPendingToolCalls(item.id);
    assert.equal(pending.length, 1);
    assert.deepEqual(pending[0]?.arguments, {
      path: "src/result.ts",
      content: "export const result = true;\n",
      beforeSha256: null,
    });
    assert.equal(controlPlane.approvedPendingToolCall(item.id), null);
    assert.equal(
      controlPlane.isToolCallApproved(
        item.id,
        callHash,
        "workspace.write_file",
      ),
      false,
    );
    assert.throws(
      () =>
        controlPlane.approveToolCall({
          id: item.id,
          callHash,
          toolName: "workspace.write_file",
          packetHash: currentPacketHash(controlPlane, item.id),
          actor: "role:model",
          note: "A model cannot approve itself.",
          idempotencyKey: "tool:invalid-approval",
        }),
      /human actor/u,
    );
    controlPlane.approveToolCall({
      id: item.id,
      callHash,
      toolName: "workspace.write_file",
      packetHash: currentPacketHash(controlPlane, item.id),
      actor: "human:test",
      note: "Exact arguments were reviewed.",
      idempotencyKey: "tool:approval",
    });
    assert.equal(
      controlPlane.isToolCallApproved(
        item.id,
        callHash,
        "workspace.write_file",
      ),
      true,
    );
    const ready = controlPlane.get(item.id);
    assert.equal(ready.status, "ready");
    assert.equal(ready.availability, "ready");
    assert.equal(ready.wait, null);
    assert.equal(
      controlPlane.approvedPendingToolCall(item.id)?.callHash,
      callHash,
    );
    const evidenceClaim = controlPlane.claim({
      id: item.id,
      actor: "runner:test",
      idempotencyKey: "tool:evidence-claim",
    });
    assert.throws(
      () =>
        controlPlane.prepareToolEvidence({
          id: item.id,
          runId: evidenceClaim.runId,
          attemptId: evidenceClaim.attemptId,
          leaseId: evidenceClaim.leaseId,
          generation: evidenceClaim.generation,
          callHash,
          toolName: "workspace.write_file",
          inputHash: "b".repeat(64),
          actor: "runner:forged",
        }),
      /RUN_OWNERSHIP_FENCE_MISMATCH/u,
    );
    let runtimeReceipt: ToolEvidenceReceipt | undefined;
    const runtime = createWorkspaceToolRuntime({
      workspaceRoot: directory,
      workItemId: item.id,
      policy: {
        allow: ["workspace.write_file"],
        approvalRequired: ["workspace.write_file"],
        workspaceRoots: ["."],
        maxIterations: 2,
      },
      isApproved: (hash, toolName) =>
        controlPlane.isToolCallApproved(item.id, hash, toolName),
      prepareEvidence: (intent) =>
        controlPlane.prepareToolEvidence({
          id: item.id,
          runId: evidenceClaim.runId,
          attemptId: evidenceClaim.attemptId,
          leaseId: evidenceClaim.leaseId,
          generation: evidenceClaim.generation,
          callHash: intent.callHash,
          toolName: intent.toolName,
          inputHash: intent.inputHash,
          actor: "runner:test",
        }),
      onEvidence: (runtimeEvidence, receipt) => {
        assert.ok(receipt);
        runtimeReceipt = receipt;
        controlPlane.recordToolEvidence({
          receipt,
          evidenceId: runtimeEvidence.id,
          id: item.id,
          runId: evidenceClaim.runId,
          attemptId: evidenceClaim.attemptId,
          leaseId: evidenceClaim.leaseId,
          generation: evidenceClaim.generation,
          callHash: runtimeEvidence.callHash,
          toolName: runtimeEvidence.toolName,
          status: runtimeEvidence.status,
          inputHash: runtimeEvidence.inputHash,
          outputHash: runtimeEvidence.outputHash,
          paths: runtimeEvidence.paths,
          durationMs: runtimeEvidence.durationMs,
          createdAt: runtimeEvidence.createdAt,
          actor: "runner:test",
        });
      },
    });
    const execution = await runtime.executeApprovedCall(call);
    assert.equal(execution.evidence.status, "succeeded");
    assert.ok(runtimeReceipt);
    const executed = controlPlane.markPendingToolCallExecuted({
      id: item.id,
      ...runFence(evidenceClaim),
      callHash,
      evidenceId: execution.evidence.id,
      actor: "runner:test",
      idempotencyKey: "tool:pending-executed",
    });
    assert.equal(executed.status, "executed");
    assert.equal(controlPlane.approvedPendingToolCall(item.id), null);
    const evidence = controlPlane.listToolEvidence(item.id);
    assert.equal(evidence.length, 1);
    assert.equal(evidence[0]?.callHash, callHash);
    assert.deepEqual(evidence[0]?.paths, ["src/result.ts"]);
    assert.equal(evidence[0]?.receiptId, runtimeReceipt.id);
    assert.equal(evidence[0]?.provenance, "control_plane_receipt");
    database
      .prepare(`
        INSERT INTO tool_evidence(
          id, work_item_id, run_id, attempt_id, call_hash, tool_name,
          status, input_hash, output_hash, paths_json, duration_ms, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'succeeded', ?, ?, '[]', 1, ?)
      `)
      .run(
        "legacy-unreceipted-evidence",
        item.id,
        evidenceClaim.runId,
        evidenceClaim.attemptId,
        "f".repeat(64),
        "trusted.check",
        "d".repeat(64),
        "e".repeat(64),
        new Date().toISOString(),
      );
    assert.equal(controlPlane.listToolEvidence(item.id).length, 1);
    assert.throws(
      () =>
        controlPlane.recordToolEvidence({
          receipt: runtimeReceipt!,
          evidenceId: "tool-evidence-replayed-receipt",
          id: item.id,
          runId: evidenceClaim.runId,
          attemptId: evidenceClaim.attemptId,
          leaseId: evidenceClaim.leaseId,
          generation: evidenceClaim.generation,
          callHash,
          toolName: "workspace.write_file",
          status: "succeeded",
          inputHash: execution.evidence.inputHash,
          outputHash: execution.evidence.outputHash,
          paths: ["src/result.ts"],
          durationMs: 1,
          createdAt: new Date().toISOString(),
          actor: "runner:test",
        }),
      /Tool Runtime receipt/u,
    );
    const stalePreparation = controlPlane.prepareToolEvidence({
      id: item.id,
      runId: evidenceClaim.runId,
      attemptId: evidenceClaim.attemptId,
      leaseId: evidenceClaim.leaseId,
      generation: evidenceClaim.generation,
      callHash,
      toolName: "workspace.write_file",
      inputHash: "d".repeat(64),
      actor: "runner:test",
    });
    assert.throws(
      () =>
        controlPlane.recordToolEvidence({
          receipt: {
            ...stalePreparation,
            runtimeProof: "forged-stale-runtime-proof",
          },
          evidenceId: "tool-evidence-forged-lineage",
          id: item.id,
          runId: claim.runId,
          attemptId: claim.attemptId,
          leaseId: claim.leaseId,
          generation: claim.generation,
          callHash,
          toolName: "workspace.write_file",
          status: "succeeded",
          inputHash: "d".repeat(64),
          outputHash: "e".repeat(64),
          paths: ["src/forged.ts"],
          durationMs: 1,
          createdAt: new Date().toISOString(),
          actor: "runner:test",
        }),
      /RUN_OWNERSHIP_FENCE_MISMATCH/u,
    );
  } finally {
    database.close();
  }
});

test("audit export projection preserves allowlisted evidence and drops all other fields", () => {
  const { database, controlPlane } = fixture();
  try {
    database
      .prepare(
        `INSERT INTO events(
          event_type, work_item_id, actor, payload_json, created_at
        ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        "fixture.audit",
        null,
        "must-not-export-actor-secret",
        JSON.stringify({
          sha256: "a".repeat(64),
          producerReportHash: "b".repeat(64),
          token: "must-not-export",
          nested: { arguments: { path: ".", content: "private" } },
        }),
        new Date().toISOString(),
      );
    const records = controlPlane.auditRecords();
    assert.equal(records[0]?.payload.sha256, "a".repeat(64));
    assert.equal(records[0]?.payload.producerReportHash, "b".repeat(64));
    assert.equal(records[0]?.payload.token, undefined);
    assert.equal(records[0]?.payload.nested, undefined);
    assert.equal(records[0]?.actor, "system:unknown");
    assert.doesNotMatch(JSON.stringify(records), /must-not-export|private/u);
  } finally {
    database.close();
  }
});

test("model invocation lifecycle survives cancellation and lease recovery", () => {
  const { database, controlPlane } = fixture();
  try {
    const prepare = (name: string) => {
      const item = controlPlane.intake({
        title: name,
        summary: "Track the call before model execution starts.",
        actor: "human:test",
        idempotencyKey: `invocation:intake:${name}`,
      });
      controlPlane.triage({
        id: item.id,
        ownerRole: "operator",
        executionTarget: "local",
        actor: "human:test",
        idempotencyKey: `invocation:triage:${name}`,
      });
      return item;
    };
    const canceledItem = prepare("cancel");
    const canceledClaim = controlPlane.claim({
      id: canceledItem.id,
      actor: "runner:test",
      idempotencyKey: "invocation:claim:cancel",
    });
    const running = controlPlane.startInvocation({
      attemptId: canceledClaim.attemptId,
      engineId: "local-model",
      modelId: "fixture",
    });
    assert.equal(running.status, "running");
    assert.equal(running.finishedAt, null);
    const cancellation = controlPlane.requestRunCancellation({
      id: canceledItem.id,
      actor: "human:test",
      idempotencyKey: "invocation:cancel",
    });
    assert.equal(cancellation.runId, canceledClaim.runId);
    assert.equal(
      controlPlane.isRunCancellationRequested(canceledClaim.runId),
      true,
    );
    assert.equal(
      controlPlane.finishInvocation({
        id: running.id,
        status: "canceled",
        inputTokens: null,
        outputTokens: null,
        cost: null,
        measurementStatus: "unknown",
      }).status,
      "canceled",
    );

    const abandonedItem = prepare("abandon");
    const abandonedClaim = controlPlane.claim({
      id: abandonedItem.id,
      actor: "runner:test",
      idempotencyKey: "invocation:claim:abandon",
      leaseMinutes: 0,
    });
    const abandoned = controlPlane.startInvocation({
      attemptId: abandonedClaim.attemptId,
      engineId: "local-model",
      modelId: "fixture",
    });
    controlPlane.recoverExpiredLeases();
    assert.equal(
      controlPlane
        .listInvocations(abandonedClaim.attemptId)
        .find(({ id }) => id === abandoned.id)?.status,
      "abandoned",
    );
    assert.ok(
      controlPlane
        .auditRecords()
        .some(
          ({ type, payload }) =>
            type === "model.invocation.abandoned" &&
            payload.invocationId === abandoned.id,
        ),
    );
  } finally {
    database.close();
  }
});

test("work pagination is stable and explicit archive hides terminal work", () => {
  const { database, controlPlane } = fixture();
  try {
    for (const name of ["one", "two", "three"]) {
      controlPlane.intake({
        title: name,
        summary: `Pagination fixture ${name}.`,
        actor: "human:test",
        idempotencyKey: `page:${name}`,
      });
    }
    const first = controlPlane.listPage({
      limit: 2,
      includeCompleted: true,
    });
    assert.equal(first.items.length, 2);
    assert.ok(first.nextCursor);
    const second = controlPlane.listPage({
      cursor: first.nextCursor!,
      limit: 2,
      includeCompleted: true,
    });
    assert.equal(second.items.length, 1);
    assert.equal(
      new Set([...first.items, ...second.items].map(({ id }) => id)).size,
      3,
    );
    const terminal = first.items[0]!;
    database
      .prepare(`
        UPDATE work_items
        SET status = 'done', availability = 'completed'
        WHERE id = ?
      `)
      .run(terminal.id);
    assert.ok(
      controlPlane.archive({
        id: terminal.id,
        actor: "human:test",
        idempotencyKey: "page:archive",
      }).archivedAt,
    );
    assert.equal(
      controlPlane.list().some(({ id }) => id === terminal.id),
      false,
    );
    assert.equal(
      controlPlane
        .list({ includeArchived: true })
        .some(({ id }) => id === terminal.id),
      true,
    );
  } finally {
    database.close();
  }
});

test("outbox dispatcher retries, dead-letters, and permits human replay", async () => {
  const { database, controlPlane } = fixture();
  try {
    controlPlane.intake({
      title: "Dispatch one event",
      summary: "Exercise local transactional outbox delivery.",
      actor: "human:test",
      idempotencyKey: "outbox:intake",
    });
    const failed = await dispatchOutboxBatch(controlPlane, {
      owner: "dispatcher:test",
      maxAttempts: 1,
      handler: () => {
        throw new Error("FIXTURE_DELIVERY_FAILED");
      },
    });
    assert.equal(failed.deadLettered, 1);
    const dead = controlPlane.listOutbox({
      deadLettersOnly: true,
    });
    assert.equal(dead.length, 1);
    controlPlane.retryDeadLetter({
      id: dead[0]!.id,
      actor: "human:test",
      idempotencyKey: "outbox:retry",
    });
    const delivered: number[] = [];
    const succeeded = await dispatchOutboxBatch(controlPlane, {
      owner: "dispatcher:test",
      handler: (delivery) => {
        delivered.push(delivery.id);
      },
    });
    assert.ok(succeeded.dispatched >= 1);
    assert.ok(delivered.includes(dead[0]!.id));
  } finally {
    database.close();
  }
});
