import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { defaultProjectPreferences } from "../../../packages/runtime/src/index.ts";
import { beginApplyOperation } from "../src/apply-operation-journal.ts";

function invoke(args: string[]) {
  return spawnSync(process.execPath, [resolve("bin/chartermesh.mjs"), ...args, "--json"], {
    encoding: "utf8", timeout: 30_000, env: { ...process.env, CHARTERMESH_NO_UPDATE_CHECK: "1" },
  });
}
function cli(args: string[]) {
  const result = invoke(args);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return JSON.parse(result.stdout).data;
}
function fixture() {
  const target = mkdtempSync(join(tmpdir(), "chartermesh-customize-"));
  const args = ["bootstrap", "--target", target, "--engine", "fake", "--profile", "controlled"];
  const plan = cli(args);
  cli([...args, "--approve", plan.planHash]);
  return target;
}
function candidateFile(target: string, name: string, candidate: unknown) {
  const file = join(target, name);
  writeFileSync(file, JSON.stringify(candidate, null, 2));
  return file;
}
function expectRejected(args: string[], pattern: RegExp) {
  const result = invoke(args);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, pattern);
}

test("preferences preview is read-only, exact approval applies, retries and refresh preserve settings", () => {
  const target = fixture();
  const before = readFileSync(join(target, ".chartermesh", "preferences.json"), "utf8");
  const prefs = { ...defaultProjectPreferences(), language: "ko", approvalDetail: "concise", tone: "formal",
    projectInstructions: "읽기 쉬운 짧은 보고서를 작성하세요.", roleInstructions: { operator: "사용자 입장에서 설명하세요." } };
  const path = candidateFile(target, "preferences-candidate.json", prefs);
  const args = ["configure-project", "--target", target, "--preferences-file", path];
  const statePath = join(target, ".chartermesh");
  const stateBefore = { entries: readdirSync(statePath), mtime: statSync(statePath).mtimeMs,
    database: readFileSync(join(statePath, "state.db")) };
  const plan = cli(args);
  assert.deepEqual({ entries: readdirSync(statePath), mtime: statSync(statePath).mtimeMs,
    database: readFileSync(join(statePath, "state.db")) }, stateBefore);
  assert.equal(plan.operation, "configure-project");
  assert.equal(plan.approvalRequired, true);
  assert.match(plan.projectGuard.workSnapshotHash, /^[a-f0-9]{64}$/u);
  assert.equal(readFileSync(join(target, ".chartermesh", "preferences.json"), "utf8"), before);
  assert.equal(existsSync(join(target, ".chartermesh", "project-customization.json")), false);
  expectRejected([...args, "--approve", "a".repeat(64)], /hash does not match/iu);
  const applied = cli([...args, "--approve", plan.planHash]);
  assert.equal(applied.applied, true);
  assert.deepEqual(cli(["project-config", "--target", target]).preferences, prefs);
  assert.match(readFileSync(join(target, ".chartermesh", "PREFERENCES.md"), "utf8"), /읽기 쉬운 짧은 보고서/u);
  assert.deepEqual(cli([...args, "--approve", plan.planHash]), applied);
  const refreshArgs = ["configure-project", "--target", target];
  const refresh = cli(refreshArgs);
  cli([...refreshArgs, "--approve", refresh.planHash]);
  assert.deepEqual(cli(["project-config", "--target", target]).preferences, prefs);
  expectRejected(["bootstrap", "--target", target, "--engine", "fake"], /PROJECT_CUSTOMIZED/u);
  cli(["doctor", "--target", target]);
});

test("custom teams and charter change together; intake can be assigned to a new role", () => {
  const target = fixture();
  const current = cli(["project-config", "--target", target]).organization;
  const candidate = structuredClone(current);
  candidate.metadata.revision++;
  candidate.spec.roles.push({ ...candidate.spec.roles.find((role: { id: string }) => role.id === "operator"),
    id: "editor", name: "Newsletter Editor", capabilities: ["newsletter_editing"] });
  const file = candidateFile(target, "organization-candidate.json", candidate);
  const item = cli(["request", "--target", target, "--title", "Newsletter draft", "--idempotency-key", "custom-intake"]);
  const args = ["configure-project", "--target", target, "--organization-file", file];
  const plan = cli(args);
  assert.deepEqual(cli(["project-config", "--target", target]).organization, current);
  cli([...args, "--approve", plan.planHash]);
  assert.deepEqual(cli(["project-config", "--target", target]).organization, candidate);
  assert.match(readFileSync(join(target, ".chartermesh", "TEAM-CHARTER.md"), "utf8"), /Newsletter Editor/u);
  const design = JSON.parse(readFileSync(join(target, ".chartermesh", "team-design.json"), "utf8"));
  assert.equal(design.source, "approved_custom_orgspec");
  assert.deepEqual(design.roles, candidate.spec.roles);
  const triaged = cli(["triage", "--target", target, "--id", item.id, "--role", "editor", "--execution-target", "local", "--idempotency-key", "editor-triage"]);
  assert.equal(triaged.ownerRole, "editor");
  cli(["doctor", "--target", target]);
});

test("changed files or work invalidate a preview without applying preferences", () => {
  const target = fixture();
  const args = ["configure-project", "--target", target];
  const plan = cli(args);
  cli(["request", "--target", target, "--title", "A new request", "--idempotency-key", "stale-work"]);
  expectRejected([...args, "--approve", plan.planHash], /hash does not match|WORK_CHANGED/iu);
  const next = cli(args);
  writeFileSync(join(target, ".chartermesh", "PREFERENCES.md"), "User edited explanation\n");
  expectRejected([...args, "--approve", next.planHash], /hash does not match/iu);
  assert.equal(existsSync(join(target, ".chartermesh", "project-customization.json")), false);
});

test("active runs and dangling role assignments prevent organization mutation", () => {
  const target = fixture();
  const item = cli(["request", "--target", target, "--title", "Assigned work", "--idempotency-key", "assigned"]);
  cli(["triage", "--target", target, "--id", item.id, "--role", "operator", "--execution-target", "local", "--idempotency-key", "assigned-triage"]);
  const db = new DatabaseSync(join(target, ".chartermesh", "state.db"));
  try {
    db.prepare("UPDATE work_items SET status='in_progress' WHERE id=?").run(item.id);
    expectRejected(["configure-project", "--target", target], /PROJECT_CONFIGURATION_BUSY/u);
    db.prepare("UPDATE work_items SET status='ready', owner_role='removed-role' WHERE id=?").run(item.id);
    // A live WAL is conservatively busy rather than read through a mutating connection.
    expectRejected(["configure-project", "--target", target], /PROJECT_CONFIGURATION_ORPHAN_WORK|PROJECT_CONFIGURATION_BUSY/u);
  } finally { db.close(); }
  expectRejected(["configure-project", "--target", target], /PROJECT_CONFIGURATION_ORPHAN_WORK/u);
  assert.equal(existsSync(join(target, ".chartermesh", "project-customization.json")), false);
});

test("invalid preferences, authority fields and unknown role guidance fail before writes", () => {
  const target = fixture();
  for (const preferences of [
    { ...defaultProjectPreferences(), approvalDetail: "skip-approval" },
    { ...defaultProjectPreferences(), autoApprove: true },
    { ...defaultProjectPreferences(), roleInstructions: { missing: "Help me." } },
  ]) {
    const file = candidateFile(target, "bad-preferences.json", preferences);
    expectRejected(["configure-project", "--target", target, "--preferences-file", file], /PROJECT_PREFERENCES/u);
  }
  assert.equal(existsSync(join(target, ".chartermesh", "project-customization.json")), false);
  writeFileSync(join(target, ".chartermesh", "preferences.json"), "{}");
  expectRejected(["doctor", "--target", target], /PROJECT_PREFERENCES/u);
});

test("durable maintenance blocks new work during interrupted apply and exact receipt resumes", () => {
  const target = fixture();
  const args = ["configure-project", "--target", target];
  const { applied: _applied, approvalRequired: _required, ...plan } = cli(args);
  beginApplyOperation(target, plan.planHash, plan);
  const pending = () => {
    const db = new DatabaseSync(join(target, ".chartermesh", "state.db"));
    try { db.prepare("INSERT INTO metadata(key,value) VALUES ('project_configuration_pending', ?)").run(plan.planHash); }
    finally { db.close(); }
  };
  pending();
  expectRejected(["request", "--target", target, "--title", "Must wait", "--idempotency-key", "wait"], /PROJECT_CONFIGURATION_PENDING/u);
  expectRejected(["doctor", "--target", target], /PROJECT_CONFIGURATION_PENDING/u);
  cli([...args, "--approve", plan.planHash]);
  cli(["doctor", "--target", target]);
  // A crash after the receipt settled but before the marker deletion committed.
  pending();
  cli([...args, "--approve", plan.planHash]);
  cli(["request", "--target", target, "--title", "Can proceed", "--idempotency-key", "proceed"]);
});

test("approved refresh upgrades version pins without resetting organization or user guide text", () => {
  const target = fixture();
  const original = cli(["project-config", "--target", target]).organization;
  const path = join(target, ".chartermesh", "installation.json");
  const installation = JSON.parse(readFileSync(path, "utf8"));
  installation.charterMeshVersion = "0.0.9-alpha.1";
  writeFileSync(path, JSON.stringify(installation));
  writeFileSync(join(target, "CHARTERMESH.md"), "Keep my note.\nnpx --yes github:jade-blanco/chartermesh#v0.0.9-alpha.1 doctor --target .\n");
  const args = ["configure-project", "--target", target];
  const plan = cli(args);
  cli([...args, "--approve", plan.planHash]);
  assert.equal(JSON.parse(readFileSync(path, "utf8")).charterMeshVersion, "0.0.10-alpha.1");
  assert.deepEqual(cli(["project-config", "--target", target]).organization, original);
  assert.match(readFileSync(join(target, "CHARTERMESH.md"), "utf8"), /Keep my note\.[\s\S]*#v0\.0\.10-alpha\.1/u);
  cli(["doctor", "--target", target]);
});

test("marker and stored exact plan recover even if the candidate disappears before journal creation", () => {
  const target = fixture();
  const preferences = { ...defaultProjectPreferences(), approvalDetail: "technical" };
  const file = candidateFile(target, "temporary-candidate.json", preferences);
  const args = ["configure-project", "--target", target, "--preferences-file", file];
  const { applied: _applied, approvalRequired: _required, ...plan } = cli(args);
  const database = new DatabaseSync(join(target, ".chartermesh", "state.db"));
  try {
    database.exec("BEGIN IMMEDIATE");
    database.prepare("INSERT INTO metadata(key,value) VALUES ('project_configuration_pending', ?)").run(plan.planHash);
    database.prepare("INSERT INTO metadata(key,value) VALUES ('project_configuration_plan', ?)").run(JSON.stringify(plan));
    database.exec("COMMIT");
  } finally { database.close(); }
  // Simulate an editor replacing the ephemeral input after process death.
  writeFileSync(file, "not JSON anymore");
  cli([...args, "--approve", plan.planHash]);
  assert.deepEqual(cli(["project-config", "--target", target]).preferences, preferences);
  cli(["doctor", "--target", target]);
});
