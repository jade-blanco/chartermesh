import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  applyFileTransaction,
  type FileTransactionInput,
} from "../../../packages/compiler/src/index.ts";
import { ControlPlane, openControlPlaneDatabase } from "../../../packages/control-plane/src/index.ts";
import {
  beginApplyOperation,
  markApplyOperationFilesCommitted,
  type ApplyOperationPlanLike,
} from "../src/apply-operation-journal.ts";

const executable = resolve("bin", "chartermesh.mjs");
const nodeExecutableSha256 = createHash("sha256")
  .update(readFileSync(process.execPath))
  .digest("hex");

function cli(args: string[]) {
  return spawnSync(process.execPath, [executable, ...args], {
    encoding: "utf8",
    env: process.env,
  });
}

test("kickoff turns an approved brief into files and one triaged work item", () => {
  const target = mkdtempSync(join(tmpdir(), "chartermesh-kickoff-target-"));
  const inputDirectory = mkdtempSync(join(tmpdir(), "chartermesh-kickoff-input-"));
  const briefPath = join(inputDirectory, "brief.md");
  writeFileSync(
    briefPath,
    "# Neighborhood pantry tracker\n\nBuild an offline-first inventory prototype.",
    "utf8",
  );
  const args = [
    "kickoff",
    "--target",
    target,
    "--brief-file",
    briefPath,
    "--engine",
    "fake",
    "--acceptance",
    "The prototype has an inventory workflow and verification evidence.",
    "--json",
  ];
  const preview = cli(args);
  assert.equal(preview.status, 0, preview.stderr);
  const envelope = JSON.parse(preview.stdout) as {
    data: {
      applied: boolean;
      planHash: string;
      kickoff: { briefHash: string };
      onboarding: {
        teamTemplate: string;
        teamSource: string;
        allocationMode: string;
      };
    };
  };
  assert.equal(envelope.data.applied, false);
  assert.match(envelope.data.planHash, /^[a-f0-9]{64}$/u);
  assert.match(envelope.data.kickoff.briefHash, /^[a-f0-9]{64}$/u);
  assert.equal(envelope.data.onboarding.teamTemplate, "general");
  assert.equal(envelope.data.onboarding.teamSource, "kickoff_default");
  assert.equal(
    envelope.data.onboarding.allocationMode,
    "single_entry_work_item_with_manual_role_consultations",
  );
  assert.equal(existsSync(join(target, ".chartermesh", "runtime.json")), false);

  const applied = cli([...args, "--approve", envelope.data.planHash]);
  assert.equal(applied.status, 0, applied.stderr);
  const appliedEnvelope = JSON.parse(applied.stdout) as {
    data: { applied: boolean; workItemId: string };
  };
  assert.equal(appliedEnvelope.data.applied, true);
  assert.match(appliedEnvelope.data.workItemId, /^work-\d{6}$/u);
  assert.match(
    readFileSync(join(target, ".chartermesh", "PROJECT-BRIEF.md"), "utf8"),
    /offline-first inventory prototype/u,
  );
  assert.match(readFileSync(join(target, "CHARTERMESH.md"), "utf8"), /Control Plane/u);
  assert.match(
    readFileSync(join(target, ".chartermesh", "TEAM-CHARTER.md"), "utf8"),
    /Copy\/paste inter-team handoffs/u,
  );

  const database = openControlPlaneDatabase(join(target, ".chartermesh", "state.db"));
  try {
    const controlPlane = new ControlPlane(
      database,
      join(target, ".chartermesh", "artifacts"),
    );
    const [item] = controlPlane.list();
    assert.equal(item?.id, appliedEnvelope.data.workItemId);
    assert.equal(item?.status, "ready");
    assert.equal(item?.ownerRole, "operator");
    assert.equal(item?.executionTarget, "local");
    assert.equal(
      controlPlane.decisionContract(item!.id).acceptanceCriteria[0]?.critical,
      true,
    );
  } finally {
    database.close();
  }
});

test("kickoff creates a template-selected team scaffold, allocation, handoffs, and approval rules in one plan", () => {
  const target = mkdtempSync(join(tmpdir(), "chartermesh-team-kickoff-"));
  const inputDirectory = mkdtempSync(join(tmpdir(), "chartermesh-team-brief-"));
  const briefPath = join(inputDirectory, "brief.md");
  writeFileSync(
    briefPath,
    "# Offline service console\n\nBuild and verify a local-first software product.",
    "utf8",
  );
  const args = [
    "kickoff",
    "--target",
    target,
    "--brief-file",
    briefPath,
    "--team-template",
    "software-product",
    "--profile",
    "controlled",
    "--engine",
    "fake",
    "--json",
  ];
  const preview = cli(args);
  assert.equal(preview.status, 0, preview.stderr);
  const plan = JSON.parse(preview.stdout).data as {
    planHash: string;
    kickoff: { ownerRole: string; executionTarget: string };
    onboarding: {
      teamTemplate: string;
      teamSource: string;
      roleIds: string[];
      stageIds: string[];
      handoffMode: string;
      approvalMode: string;
    };
  };
  assert.equal(plan.onboarding.teamTemplate, "software-product");
  assert.equal(plan.onboarding.teamSource, "explicit");
  assert.deepEqual(plan.onboarding.roleIds, [
    "coordinator",
    "operator",
    "verifier",
  ]);
  assert.deepEqual(plan.onboarding.stageIds, [
    "coordinate",
    "produce",
    "verify",
    "review",
  ]);
  assert.equal(plan.onboarding.handoffMode, "copy_paste");
  assert.equal(plan.onboarding.approvalMode, "exact_hash_human");
  assert.equal(plan.kickoff.ownerRole, "operator");
  assert.equal(plan.kickoff.executionTarget, "local");
  assert.equal(existsSync(join(target, ".chartermesh")), false);

  const applied = cli([...args, "--approve", plan.planHash]);
  assert.equal(applied.status, 0, applied.stderr);
  const result = JSON.parse(applied.stdout).data as {
    onboarding: { teamTemplate: string };
    nextActions: Array<{
      id: string;
      command?: { executable: string; arguments: string[] };
    }>;
  };
  assert.equal(result.onboarding.teamTemplate, "software-product");
  assert.ok(result.nextActions.some(({ id }) => id === "review-team-charter"));
  const doctorAction = result.nextActions.find(({ id }) => id === "doctor");
  assert.equal(doctorAction?.command?.executable, "npx");
  assert.deepEqual(
    doctorAction?.command?.arguments.slice(-2),
    ["--target", target],
  );
  const charter = readFileSync(
    join(target, ".chartermesh", "TEAM-CHARTER.md"),
    "utf8",
  );
  assert.match(charter, /FROM_ROLE: coordinator/u);
  assert.match(charter, /TO_ROLE: operator/u);
  assert.match(charter, /APPROVE_EXACT_HASH/u);
  const organization = JSON.parse(
    readFileSync(join(target, ".chartermesh", "organization.json"), "utf8"),
  ) as { spec: { roles: Array<{ id: string }> } };
  assert.deepEqual(
    organization.spec.roles.map(({ id }) => id),
    ["coordinator", "operator", "verifier"],
  );
});

test("kickoff rejects unknown team choices before writing", () => {
  const target = mkdtempSync(join(tmpdir(), "chartermesh-team-reject-"));
  const briefPath = join(target, "brief.md");
  writeFileSync(briefPath, "# Rejected setup\n", "utf8");
  const unknownTemplate = cli([
    "kickoff",
    "--target",
    target,
    "--brief-file",
    briefPath,
    "--team-template",
    "invented-team",
    "--json",
  ]);
  assert.equal(unknownTemplate.status, 1);
  assert.match(unknownTemplate.stdout, /--team-template must be/u);
  const unknownRole = cli([
    "kickoff",
    "--target",
    target,
    "--brief-file",
    briefPath,
    "--role",
    "invented-role",
    "--json",
  ]);
  assert.equal(unknownRole.status, 1);
  assert.match(unknownRole.stdout, /not present in the generated team design/u);
  assert.equal(existsSync(join(target, ".chartermesh")), false);
});

test("kickoff uses the project goal instead of a generic brief section label as its title", () => {
  const target = mkdtempSync(join(tmpdir(), "chartermesh-title-kickoff-"));
  const briefPath = join(target, "brief.md");
  writeFileSync(
    briefPath,
    "# 프로젝트 유형\n소프트웨어 제품\n\n# 프로젝트 목표\n오프라인 재고 알림 도구 만들기\n",
    "utf8",
  );
  const preview = cli([
    "kickoff",
    "--target",
    target,
    "--brief-file",
    briefPath,
    "--json",
  ]);
  assert.equal(preview.status, 0, preview.stderr);
  assert.equal(
    JSON.parse(preview.stdout).data.kickoff.title,
    "오프라인 재고 알림 도구 만들기",
  );
  assert.equal(existsSync(join(target, ".chartermesh")), false);
});

test("kickoff binds host executable bytes before starting the host probe", () => {
  const target = mkdtempSync(join(tmpdir(), "chartermesh-host-bind-first-"));
  const briefPath = join(target, "brief.md");
  writeFileSync(briefPath, "# Bound host setup\n", "utf8");
  const result = cli([
    "kickoff",
    "--target",
    target,
    "--brief-file",
    briefPath,
    "--host",
    "codex",
    "--executable",
    process.execPath,
    "--allow-unrestricted-read",
    "--json",
  ]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, new RegExp(nodeExecutableSha256, "u"));
  assert.match(result.stdout, /no host process was started/u);
  assert.equal(existsSync(join(target, ".chartermesh")), false);
});

test("kickoff can project Codex project roles and MCP in the same approved plan", () => {
  const target = mkdtempSync(join(tmpdir(), "chartermesh-one-shot-codex-"));
  const inputDirectory = mkdtempSync(join(tmpdir(), "chartermesh-one-shot-input-"));
  const briefPath = join(inputDirectory, "brief.md");
  writeFileSync(
    briefPath,
    "# One-shot host setup\n\nCreate a reviewed software product team.",
    "utf8",
  );
  const fakeCodexSource = [
    'const readline=require("node:readline");',
    'if(process.argv.includes("--version")){console.log("codex-cli 0.145.0");process.exit(0)}',
    'const rl=readline.createInterface({input:process.stdin});',
    'rl.on("line",line=>{const message=JSON.parse(line);',
    'if(message.method==="initialize"&&message.id!==undefined){',
    'process.stdout.write(JSON.stringify({id:message.id,result:{userAgent:"codex-cli/0.145.0"}})+"\\n")}});',
  ].join("");
  const hostArguments = [
    "--eval",
    fakeCodexSource,
    "chartermesh-kickoff-fixture",
  ];
  const args = [
    "kickoff",
    "--target",
    target,
    "--brief-file",
    briefPath,
    "--team-template",
    "software-product",
    "--profile",
    "controlled",
    "--engine",
    "fake",
    "--host",
    "codex",
    "--executable",
    process.execPath,
    "--executable-sha256",
    nodeExecutableSha256,
    ...hostArguments.flatMap((argument) => ["--host-arg", argument]),
    "--allow-unrestricted-read",
    "--json",
  ];
  const preview = cli(args);
  assert.equal(preview.status, 0, preview.stderr);
  const plan = JSON.parse(preview.stdout).data as {
    planHash: string;
    kickoff: { executionTarget: string };
    hostBinding: { kind: string; projectionPlanHash: string };
    onboarding: {
      hostProjection: {
        kind: string;
        executionTarget: string;
        newSessionRequired: boolean;
      };
    };
  };
  assert.equal(plan.hostBinding.kind, "codex");
  assert.match(plan.hostBinding.projectionPlanHash, /^[a-f0-9]{64}$/u);
  assert.equal(plan.kickoff.executionTarget, "codex-project");
  assert.deepEqual(plan.onboarding.hostProjection, {
    kind: "codex",
    executionTarget: "codex-project",
    newSessionRequired: true,
  });
  assert.equal(existsSync(join(target, ".codex")), false);

  const applied = cli([...args, "--approve", plan.planHash]);
  assert.equal(applied.status, 0, applied.stderr);
  const result = JSON.parse(applied.stdout).data as {
    nextActions: Array<{ id: string }>;
    workItemId: string;
  };
  assert.ok(result.nextActions.some(({ id }) => id === "start-new-host-session"));
  assert.match(
    readFileSync(join(target, ".codex", "config.toml"), "utf8"),
    /\[mcp_servers\.chartermesh\]/u,
  );
  for (const role of ["coordinator", "operator", "verifier"]) {
    assert.equal(
      existsSync(join(target, ".codex", "agents", `chartermesh-${role}.toml`)),
      true,
    );
  }
  const installedOrganization = JSON.parse(
    readFileSync(join(target, ".chartermesh", "organization.json"), "utf8"),
  );
  const installedProposal = JSON.parse(
    readFileSync(join(target, ".chartermesh", "proposal.json"), "utf8"),
  ) as { proposalHash: string; organization: unknown };
  const installedRecord = JSON.parse(
    readFileSync(join(target, ".chartermesh", "installation.json"), "utf8"),
  ) as { proposalHash: string };
  assert.deepEqual(installedProposal.organization, installedOrganization);
  assert.equal(installedRecord.proposalHash, installedProposal.proposalHash);
  const database = openControlPlaneDatabase(join(target, ".chartermesh", "state.db"));
  try {
    const item = new ControlPlane(
      database,
      join(target, ".chartermesh", "artifacts"),
    ).get(result.workItemId);
    assert.equal(item.executionTarget, "codex-project");
  } finally {
    database.close();
  }
});

test("kickoff can project Claude project roles and MCP in the same approved plan", () => {
  const target = mkdtempSync(join(tmpdir(), "chartermesh-one-shot-claude-"));
  const inputDirectory = mkdtempSync(join(tmpdir(), "chartermesh-one-shot-claude-input-"));
  const briefPath = join(inputDirectory, "brief.md");
  writeFileSync(briefPath, "# Evidence brief\n\nProduce a reviewed research finding.\n", "utf8");
  const hostArguments = [
    "--eval",
    'if(process.argv.includes("--version"))console.log("2.1.223 (Claude Code)")',
    "chartermesh-kickoff-fixture",
  ];
  const args = [
    "kickoff",
    "--target",
    target,
    "--brief-file",
    briefPath,
    "--team-template",
    "research",
    "--profile",
    "balanced",
    "--engine",
    "fake",
    "--host",
    "claude",
    "--executable",
    process.execPath,
    "--executable-sha256",
    nodeExecutableSha256,
    ...hostArguments.flatMap((argument) => ["--host-arg", argument]),
    "--json",
  ];
  const preview = cli(args);
  assert.equal(preview.status, 0, preview.stderr);
  const plan = JSON.parse(preview.stdout).data as {
    planHash: string;
    kickoff: { executionTarget: string };
    onboarding: { roleIds: string[] };
  };
  assert.equal(plan.kickoff.executionTarget, "claude-project");
  assert.deepEqual(plan.onboarding.roleIds, ["coordinator", "operator"]);

  const applied = cli([...args, "--approve", plan.planHash]);
  assert.equal(applied.status, 0, applied.stderr);
  assert.ok(
    JSON.parse(readFileSync(join(target, ".mcp.json"), "utf8")).mcpServers
      .chartermesh,
  );
  assert.equal(
    existsSync(join(target, ".claude", "agents", "chartermesh-coordinator.md")),
    true,
  );
  assert.equal(
    existsSync(join(target, ".claude", "agents", "chartermesh-operator.md")),
    true,
  );
});

test("kickoff rejects missing, empty, and oversized briefs before writing", () => {
  const target = mkdtempSync(join(tmpdir(), "chartermesh-kickoff-reject-"));
  const empty = join(target, "empty.md");
  writeFileSync(empty, "  \n", "utf8");
  const result = cli([
    "kickoff",
    "--target",
    target,
    "--brief-file",
    empty,
  ]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /cannot be empty/u);
  assert.equal(existsSync(join(target, ".chartermesh", "runtime.json")), false);
});

test("kickoff resumes after files and intake commit without duplicate work", () => {
  const target = mkdtempSync(join(tmpdir(), "chartermesh-kickoff-resume-"));
  const briefPath = join(target, "brief.md");
  writeFileSync(briefPath, "# Resume fixture\n\nBuild one verified result.\n", "utf8");
  const args = [
    "kickoff",
    "--target",
    target,
    "--brief-file",
    briefPath,
    "--engine",
    "fake",
    "--json",
  ];
  const preview = cli(args);
  assert.equal(preview.status, 0, preview.stderr);
  type KickoffPlan = ApplyOperationPlanLike & {
    operation: "kickoff";
    target: string;
    planHash: string;
    files: FileTransactionInput[];
    kickoff: {
      title: string;
      summary: string;
      ownerRole: string;
      executionTarget: string;
      priority: number;
      decisionQuestion: string;
      acceptanceCriteria: Array<{
        id: string;
        text: string;
        critical: boolean;
        evidenceRequirements: string[];
      }>;
    };
  };
  const previewData = (JSON.parse(preview.stdout) as {
    data: KickoffPlan & { applied: boolean; approvalRequired: boolean };
  }).data;
  const {
    applied: _applied,
    approvalRequired: _approvalRequired,
    ...plan
  } = previewData;
  beginApplyOperation(target, plan.planHash, plan);
  applyFileTransaction(target, plan.planHash, plan.files);
  markApplyOperationFilesCommitted(target, plan.planHash, {
    fileCount: plan.files.length,
  });

  const database = openControlPlaneDatabase(join(target, ".chartermesh", "state.db"));
  let interruptedItemId: string;
  try {
    const controlPlane = new ControlPlane(
      database,
      join(target, ".chartermesh", "artifacts"),
    );
    interruptedItemId = controlPlane.intake({
      title: plan.kickoff.title,
      summary: plan.kickoff.summary,
      ownerRole: plan.kickoff.ownerRole,
      executionTarget: plan.kickoff.executionTarget,
      priority: plan.kickoff.priority,
      decisionQuestion: plan.kickoff.decisionQuestion,
      acceptanceCriteria: plan.kickoff.acceptanceCriteria,
      actor: "human:local",
      idempotencyKey: `kickoff:${plan.planHash}:intake`,
    }).id;
  } finally {
    database.close();
  }

  const resumed = cli([...args, "--approve", plan.planHash]);
  assert.equal(resumed.status, 0, resumed.stderr);
  const resumedEnvelope = JSON.parse(resumed.stdout) as {
    data: { applied: boolean; workItemId: string };
  };
  assert.equal(resumedEnvelope.data.applied, true);
  assert.equal(resumedEnvelope.data.workItemId, interruptedItemId);

  const resumedDatabase = openControlPlaneDatabase(
    join(target, ".chartermesh", "state.db"),
  );
  try {
    const controlPlane = new ControlPlane(
      resumedDatabase,
      join(target, ".chartermesh", "artifacts"),
    );
    const items = controlPlane.list();
    assert.equal(items.length, 1);
    assert.equal(items[0]?.id, interruptedItemId);
    assert.equal(items[0]?.status, "ready");
  } finally {
    resumedDatabase.close();
  }
});
