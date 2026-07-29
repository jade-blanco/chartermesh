import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
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
    assert.match(html, /aria-pressed="true">전체/u);
    assert.match(html, /<th scope="col">상태<\/th>/u);
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
    assert.equal(projection.workItems[0].title, "Create a secure local request");
    assert.equal("path" in projection.workItems[0], false);

    const mutationHeaders = (key: string) => ({
      "content-type": "application/json",
      origin: dashboard.url,
      "x-chartermesh-session": token,
      "x-idempotency-key": key,
    });
    const id = projection.workItems[0].id;
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
    assert.equal(ran.status, 200, await ran.text());

    const artifact = await fetch(
      `${dashboard.url}/api/work-items/${id}/artifact`,
      { headers: { "x-chartermesh-session": token } },
    ).then((response) => response.json());
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
    const html = await fetch(dashboard.url).then((response) => response.text());
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
