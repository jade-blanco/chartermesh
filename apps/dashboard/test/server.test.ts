import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ControlPlane,
  openControlPlaneDatabase,
} from "../../../packages/control-plane/src/index.ts";
import { createProposal } from "../../cli/src/proposal.ts";
import { startDashboard } from "../src/server.ts";

function initializedTarget(): string {
  const target = mkdtempSync(join(tmpdir(), "chartermesh-dashboard-"));
  const state = join(target, ".chartermesh");
  mkdirSync(state);
  writeFileSync(
    join(state, "runtime.json"),
    JSON.stringify({
      apiVersion: "chartermesh.dev/runtime/v1alpha1",
      modelEngines: [{ id: "fixture-model", adapter: "fake" }],
      managedRunners: [
        {
          id: "fixture-runner",
          adapter: "builtin-managed-runner",
          modelEngineRef: "fixture-model",
        },
      ],
    }),
  );
  writeFileSync(
    join(state, "organization.json"),
    `${JSON.stringify(createProposal(target, "balanced").organization, null, 2)}\n`,
  );
  const database = openControlPlaneDatabase(join(state, "state.db"));
  database.close();
  return target;
}

test("dashboard refuses a linked CharterMesh state directory", async (context) => {
  const target = initializedTarget();
  const outside = mkdtempSync(join(tmpdir(), "chartermesh-dashboard-linked-"));
  const state = join(target, ".chartermesh");
  const moved = join(outside, "state");
  renameSync(state, moved);
  try {
    symlinkSync(moved, state, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EPERM" || code === "EACCES") {
      context.skip("The platform does not permit creating a test link.");
      return;
    }
    throw error;
  }
  await assert.rejects(
    startDashboard({ target, port: 0, quiet: true }),
    /PROJECT_STATE_LINK_REJECTED/u,
  );
});

test("dashboard serves one projection and protects mutations", async () => {
  const dashboard = await startDashboard({
    target: initializedTarget(),
    port: 0,
    quiet: true,
  });
  try {
    const page = await fetch(dashboard.url);
    assert.equal(page.status, 200);
    const html = await page.text();
    const token = html.match(
      /name="chartermesh-session" content="([^"]+)"/u,
    )?.[1];
    assert.ok(token);
    assert.match(html, /class="skip-link" href="#main-content"/u);
    assert.match(html, /aria-pressed="true">내 결정/u);
    assert.match(html, /id="decision-focus"/u);
    assert.match(html, /id="artifact-verified-evidence"/u);
    assert.match(html, /id="decision-dialog"/u);
    assert.match(html, /id="input-dialog"/u);
    assert.match(html, /id="artifact-packet-hash"/u);
    assert.match(html, /<th scope="col">상태<\/th>/u);
    assert.match(html, /id="tool-approval-block"/u);
    assert.match(html, /data-summary-filter="human"/u);
    assert.match(html, /aria-controls="work-results"/u);
    assert.match(html, /id="tool-impact"/u);
    assert.match(html, /id="tool-safeguards"/u);
    assert.match(html, /id="artifact-risks"/u);
    assert.match(html, /id="task-instructions-block"/u);
    assert.match(html, /id="review-feedback-block"/u);
    assert.match(
      html,
      /id="request-dialog" aria-labelledby="request-dialog-heading"/u,
    );
    const appScript = await fetch(`${dashboard.url}/app.js`).then((response) =>
      response.text(),
    );
    assert.doesNotMatch(appScript, /자동 검증/u);
    assert.match(appScript, /작업자가 보고한 수행 근거/u);

    const rejectedRead = await fetch(`${dashboard.url}/api/dashboard`);
    assert.equal(rejectedRead.status, 403);

    const rejected = await fetch(`${dashboard.url}/api/work-items`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: dashboard.url,
      },
      body: JSON.stringify({ title: "No session", summary: "Must fail." }),
    });
    assert.equal(rejected.status, 403);

    const unsupported = await fetch(`${dashboard.url}/api/work-items`, {
      method: "POST",
      headers: {
        "content-type": "text/plain",
        origin: dashboard.url,
        "x-chartermesh-session": token,
      },
      body: "not json",
    });
    assert.equal(unsupported.status, 415);

    const created = await fetch(`${dashboard.url}/api/work-items`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: dashboard.url,
        "x-chartermesh-session": token,
        "x-idempotency-key": "dashboard-test-create",
      },
      body: JSON.stringify({
        title: "Create a secure local request",
        summary: "The command becomes Control Plane state.",
      }),
    });
    assert.equal(created.status, 201);

    const projection = await fetch(`${dashboard.url}/api/dashboard`, {
      headers: { "x-chartermesh-session": token },
    }).then((response) => response.json());
    assert.equal(projection.summary.actionable, 1);
    assert.equal(
      projection.workItems[0].title,
      "Create a secure local request",
    );
    assert.equal("path" in projection.workItems[0], false);

    const mutationHeaders = (key: string) => ({
      "content-type": "application/json",
      origin: dashboard.url,
      "x-chartermesh-session": token,
      "x-idempotency-key": key,
    });
    const id = projection.workItems[0].id;
    const noReviewDecision = await fetch(
      `${dashboard.url}/api/work-items/${id}/review-decision`,
      { headers: { "x-chartermesh-session": token } },
    ).then((response) => response.json());
    assert.equal(noReviewDecision, null);
    const triaged = await fetch(
      `${dashboard.url}/api/work-items/${id}/triage`,
      {
        method: "POST",
        headers: mutationHeaders("dashboard-test-triage"),
        body: "{}",
      },
    );
    assert.equal(triaged.status, 200);

    const ran = await fetch(`${dashboard.url}/api/work-items/${id}/run`, {
      method: "POST",
      headers: mutationHeaders("dashboard-test-run"),
      body: "{}",
    });
    assert.equal(ran.status, 202, await ran.text());

    let artifactResponse: Response | undefined;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      artifactResponse = await fetch(
        `${dashboard.url}/api/work-items/${id}/artifact`,
        { headers: { "x-chartermesh-session": token } },
      );
      if (artifactResponse.status === 200) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(artifactResponse?.status, 200);
    const artifact = await artifactResponse!.json();
    assert.match(artifact.sha256, /^[a-f0-9]{64}$/u);
    assert.match(artifact.content, /Simulated CharterMesh result/u);
    const packet = await fetch(
      `${dashboard.url}/api/work-items/${id}/decision-packet`,
      { headers: { "x-chartermesh-session": token } },
    ).then((response) => response.json());
    assert.equal(packet.kind, "artifact_review");
    assert.match(packet.binding.packetHash, /^[a-f0-9]{64}$/u);

    const approved = await fetch(
      `${dashboard.url}/api/work-items/${id}/decision`,
      {
        method: "POST",
        headers: mutationHeaders("dashboard-test-approve"),
        body: JSON.stringify({
          decision: "approve",
          artifactHash: artifact.sha256,
          packetHash: packet.binding.packetHash,
          note: "Exact hash reviewed in dashboard test.",
          completeOnApprove: true,
        }),
      },
    );
    assert.equal(approved.status, 200);
    const final = await approved.json();
    assert.equal(final.status, "done");

    const archived = await fetch(
      `${dashboard.url}/api/work-items/${id}/archive`,
      {
        method: "POST",
        headers: mutationHeaders("dashboard-test-archive"),
        body: "{}",
      },
    );
    assert.equal(archived.status, 200);
    const afterArchive = await fetch(`${dashboard.url}/api/dashboard`, {
      headers: { "x-chartermesh-session": token },
    }).then((response) => response.json());
    assert.equal(afterArchive.workItems.length, 0);
  } finally {
    await dashboard.close();
  }
});

test("dashboard exposes and approves exact pending tool arguments", async () => {
  const target = initializedTarget();
  const database = openControlPlaneDatabase(
    join(target, ".chartermesh", "state.db"),
  );
  const controlPlane = new ControlPlane(
    database,
    join(target, ".chartermesh", "artifacts"),
  );
  const item = controlPlane.intake({
    title: "Preview a pending write",
    summary: "The dashboard must show exact local tool arguments.",
    actor: "human:test",
    idempotencyKey: "dashboard-tool-intake",
  });
  controlPlane.triage({
    id: item.id,
    ownerRole: "operator",
    executionTarget: "local",
    actor: "human:test",
    idempotencyKey: "dashboard-tool-triage",
  });
  const claim = controlPlane.claim({
    id: item.id,
    actor: "runner:test",
    idempotencyKey: "dashboard-tool-claim",
  });
  const callHash = "d".repeat(64);
  controlPlane.recordPendingToolCall({
    id: item.id,
    runId: claim.runId,
    attemptId: claim.attemptId,
    leaseId: claim.leaseId,
    generation: claim.generation,
    leaseId: claim.leaseId,
    generation: claim.generation,
    callHash,
    toolName: "workspace.write_file",
    arguments: {
      path: "service.mjs",
      content: "export const visible = true;\n",
    },
    createdAt: new Date().toISOString(),
    actor: "runner:test",
    idempotencyKey: "dashboard-tool-pending",
  });
  const deniedItem = controlPlane.intake({
    title: "Reject an exact tool call",
    summary: "A human can reject the exact call without leaving a deadlock.",
    actor: "human:test",
    idempotencyKey: "dashboard-tool-deny-intake",
  });
  controlPlane.triage({
    id: deniedItem.id,
    ownerRole: "operator",
    executionTarget: "local",
    actor: "human:test",
    idempotencyKey: "dashboard-tool-deny-triage",
  });
  const deniedClaim = controlPlane.claim({
    id: deniedItem.id,
    actor: "runner:test",
    idempotencyKey: "dashboard-tool-deny-claim",
  });
  const deniedCallHash = "e".repeat(64);
  controlPlane.recordPendingToolCall({
    id: deniedItem.id,
    runId: deniedClaim.runId,
    attemptId: deniedClaim.attemptId,
    leaseId: deniedClaim.leaseId,
    generation: deniedClaim.generation,
    leaseId: deniedClaim.leaseId,
    generation: deniedClaim.generation,
    callHash: deniedCallHash,
    toolName: "workspace.write_file",
    arguments: { path: "denied.mjs", content: "export const denied = true;\n" },
    createdAt: new Date().toISOString(),
    actor: "runner:test",
    idempotencyKey: "dashboard-tool-denied-pending",
  });
  database.close();

  const dashboard = await startDashboard({
    target,
    port: 0,
    quiet: true,
  });
  try {
    const html = await fetch(dashboard.url).then((response) =>
      response.text()
    );
    const token = html.match(
      /name="chartermesh-session" content="([^"]+)"/u,
    )?.[1];
    assert.ok(token);
    const readHeaders = { "x-chartermesh-session": token };
    const projection = await fetch(`${dashboard.url}/api/dashboard`, {
      headers: readHeaders,
    }).then((response) => response.json());
    assert.equal(projection.summary.approvals, 2);
    assert.equal(projection.userActions[0].category, "human_review");
    const evidence = await fetch(
      `${dashboard.url}/api/work-items/${item.id}/tool-evidence`,
      { headers: readHeaders },
    ).then((response) => response.json());
    assert.equal(
      evidence.pendingToolCalls[0].arguments.path,
      "service.mjs",
    );
    assert.match(
      evidence.pendingToolCalls[0].arguments.content,
      /visible = true/u,
    );
    assert.equal(evidence.pendingToolCalls[0].approved, false);
    const packet = await fetch(
      `${dashboard.url}/api/work-items/${item.id}/decision-packet`,
      { headers: { "x-chartermesh-session": token } },
    ).then((response) => response.json());
    assert.equal(packet.kind, "tool_execution");

    const approved = await fetch(
      `${dashboard.url}/api/work-items/${item.id}/approve-tool`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: dashboard.url,
          "x-chartermesh-session": token,
          "x-idempotency-key": "dashboard-tool-approve",
        },
        body: JSON.stringify({
          callHash,
          toolName: "workspace.write_file",
          packetHash: packet.binding.packetHash,
          note: "Exact dashboard preview reviewed.",
        }),
      },
    );
    assert.equal(approved.status, 200, await approved.text());
    const projectionAfterApproval = await fetch(
      `${dashboard.url}/api/dashboard`,
      { headers: readHeaders },
    ).then((response) => response.json());
    assert.equal(projectionAfterApproval.summary.approvals, 1);
    const after = await fetch(
      `${dashboard.url}/api/work-items/${item.id}/tool-evidence`,
      { headers: readHeaders },
    ).then((response) => response.json());
    assert.equal(after.pendingToolCalls[0].approved, true);
    const deniedPacket = await fetch(
      `${dashboard.url}/api/work-items/${deniedItem.id}/decision-packet`,
      { headers: readHeaders },
    ).then((response) => response.json());
    const denied = await fetch(
      `${dashboard.url}/api/work-items/${deniedItem.id}/deny-tool`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: dashboard.url,
          "x-chartermesh-session": token,
          "x-idempotency-key": "dashboard-tool-deny",
        },
        body: JSON.stringify({
          callHash: deniedCallHash,
          toolName: "workspace.write_file",
          packetHash: deniedPacket.binding.packetHash,
          note: "The exact dashboard change is not permitted.",
        }),
      },
    );
    assert.equal(denied.status, 200, await denied.text());
    const deniedEvidence = await fetch(
      `${dashboard.url}/api/work-items/${deniedItem.id}/tool-evidence`,
      { headers: readHeaders },
    ).then((response) => response.json());
    assert.equal(deniedEvidence.pendingToolCalls[0].status, "denied");
    const projectionAfterDenial = await fetch(
      `${dashboard.url}/api/dashboard`,
      { headers: readHeaders },
    ).then((response) => response.json());
    assert.equal(projectionAfterDenial.summary.approvals, 0);
  } finally {
    await dashboard.close();
  }
});

test("dashboard binds user input to the current request packet", async () => {
  const target = initializedTarget();
  const database = openControlPlaneDatabase(
    join(target, ".chartermesh", "state.db"),
  );
  const controlPlane = new ControlPlane(
    database,
    join(target, ".chartermesh", "artifacts"),
  );
  const item = controlPlane.intake({
    title: "Choose a release region",
    summary: "A human must choose the bounded release region.",
    actor: "human:test",
    idempotencyKey: "dashboard-input:intake",
  });
  controlPlane.triage({
    id: item.id,
    ownerRole: "operator",
    executionTarget: "local",
    actor: "human:test",
    idempotencyKey: "dashboard-input:triage",
  });
  controlPlane.wait({
    id: item.id,
    condition: {
      type: "user_input",
      reason: "Choose Korea or Japan.",
      reference: "release-region",
    },
    actor: "role:operator",
    idempotencyKey: "dashboard-input:wait",
  });
  database.close();

  const dashboard = await startDashboard({ target, port: 0, quiet: true });
  try {
    const html = await fetch(dashboard.url).then((response) => response.text());
    const token = html.match(
      /name="chartermesh-session" content="([^"]+)"/u,
    )?.[1];
    assert.ok(token);
    const packet = await fetch(
      `${dashboard.url}/api/work-items/${item.id}/decision-packet`,
      { headers: { "x-chartermesh-session": token } },
    ).then((response) => response.json());
    assert.equal(packet.kind, "user_input");
    assert.equal(packet.question, "Choose Korea or Japan.");
    const provided = await fetch(
      `${dashboard.url}/api/work-items/${item.id}/provide-input`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: dashboard.url,
          "x-chartermesh-session": token,
          "x-idempotency-key": "dashboard-input:provide",
        },
        body: JSON.stringify({
          packetHash: packet.binding.packetHash,
          response: "Use the Korea region.",
          activeReviewMs: 450,
          detailsOpenCount: 1,
        }),
      },
    );
    const responseText = await provided.text();
    assert.equal(provided.status, 200, responseText);
    const result = JSON.parse(responseText);
    assert.equal(result.workItem.availability, "ready");
    assert.match(result.input.responseHash, /^[a-f0-9]{64}$/u);
    assert.equal("response" in result.input, false);
    assert.doesNotMatch(responseText, /Use the Korea region/u);
  } finally {
    await dashboard.close();
  }
});

test("dashboard API applies a bounded loopback rate limit", async () => {
  const dashboard = await startDashboard({
    target: initializedTarget(),
    port: 0,
    quiet: true,
  });
  try {
    const html = await fetch(dashboard.url).then((response) =>
      response.text()
    );
    const token = html.match(
      /name="chartermesh-session" content="([^"]+)"/u,
    )?.[1];
    assert.ok(token);
    const headers = { "x-chartermesh-session": token };
    for (let index = 0; index < 120; index += 1) {
      const response = await fetch(`${dashboard.url}/api/runtime`, {
        headers,
      });
      assert.equal(response.status, 200);
    }
    const limited = await fetch(`${dashboard.url}/api/runtime`, { headers });
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get("retry-after")) >= 1);
  } finally {
    await dashboard.close();
  }
});
