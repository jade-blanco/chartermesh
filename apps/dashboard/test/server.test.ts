import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
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
  return target;
}

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
    assert.match(html, /aria-pressed="true">조치 필요/u);
    assert.match(html, /<th scope="col">상태<\/th>/u);
    assert.match(html, /id="tool-approval-block"/u);
    assert.match(html, /data-summary-filter="approvals"/u);
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

    const approved = await fetch(
      `${dashboard.url}/api/work-items/${id}/decision`,
      {
        method: "POST",
        headers: mutationHeaders("dashboard-test-approve"),
        body: JSON.stringify({
          decision: "approve",
          artifactHash: artifact.sha256,
          note: "Exact hash reviewed in dashboard test.",
        }),
      },
    );
    assert.equal(approved.status, 200);

    const completed = await fetch(
      `${dashboard.url}/api/work-items/${id}/complete`,
      {
        method: "POST",
        headers: mutationHeaders("dashboard-test-complete"),
        body: "{}",
      },
    );
    assert.equal(completed.status, 200);
    const final = await completed.json();
    assert.equal(final.workItem.status, "done");

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
    callHash,
    toolName: "workspace.write_file",
    arguments: {
      path: "service.mjs",
      content: "export const visible = true;\n",
    },
    createdAt: new Date().toISOString(),
    actor: "runner:test",
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
    assert.equal(projection.summary.approvals, 1);
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
          note: "Exact dashboard preview reviewed.",
        }),
      },
    );
    assert.equal(approved.status, 200, await approved.text());
    const projectionAfterApproval = await fetch(
      `${dashboard.url}/api/dashboard`,
      { headers: readHeaders },
    ).then((response) => response.json());
    assert.equal(projectionAfterApproval.summary.approvals, 0);
    const after = await fetch(
      `${dashboard.url}/api/work-items/${item.id}/tool-evidence`,
      { headers: readHeaders },
    ).then((response) => response.json());
    assert.equal(after.pendingToolCalls[0].approved, true);
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
