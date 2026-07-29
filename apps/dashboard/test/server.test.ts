import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
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

    const projection = await fetch(`${dashboard.url}/api/dashboard`).then(
      (response) => response.json(),
    );
    assert.equal(projection.summary.actionable, 1);
    assert.equal(projection.workItems[0].title, "Create a secure local request");
    assert.equal("path" in projection.workItems[0], false);
  } finally {
    await dashboard.close();
  }
});
