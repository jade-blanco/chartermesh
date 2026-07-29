import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const executable = resolve("bin", "chartermesh.mjs");

function cli(args: string[]) {
  return spawnSync(process.execPath, [executable, ...args], {
    encoding: "utf8",
    env: { ...process.env },
  });
}

test("clean target completes the fake-engine bootstrap workflow", () => {
  const target = mkdtempSync(join(tmpdir(), "chartermesh-cli-"));
  const bootstrapArgs = ["bootstrap", "--target", target, "--engine", "fake"];
  const preview = cli(bootstrapArgs);
  assert.equal(preview.status, 0, preview.stderr);
  const hash = preview.stdout.match(/Approval token: ([a-f0-9]{64})/u)?.[1];
  assert.ok(hash, preview.stdout);

  const applied = cli([...bootstrapArgs, "--approve", hash]);
  assert.equal(applied.status, 0, applied.stderr);
  assert.match(applied.stdout, /Applied CharterMesh bootstrap plan/u);

  const doctor = cli(["doctor", "--target", target]);
  assert.equal(doctor.status, 0, doctor.stdout + doctor.stderr);
  assert.match(doctor.stdout, /Runtime configuration: ready/u);

  const requested = cli([
    "request",
    "Prepare the clean-target artifact",
    "--summary",
    "Prove the provider-neutral CLI path.",
    "--target",
    target,
  ]);
  assert.equal(requested.status, 0, requested.stderr);
  const workId = requested.stdout.match(/(work-\d{6}) created/u)?.[1];
  assert.ok(workId, requested.stdout);

  const triaged = cli([
    "triage",
    "--id",
    workId,
    "--role",
    "operator",
    "--target",
    target,
  ]);
  assert.equal(triaged.status, 0, triaged.stderr);

  const run = cli(["run", "--id", workId, "--target", target]);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /submitted for review/u);
  const artifactHash = run.stdout.match(/\(([a-f0-9]{64})\)/u)?.[1];
  assert.ok(artifactHash, run.stdout);

  const decided = cli([
    "decide",
    "--id",
    workId,
    "--decision",
    "approve",
    "--artifact-hash",
    artifactHash,
    "--note",
    "Verified by the offline end-to-end test.",
    "--target",
    target,
  ]);
  assert.equal(decided.status, 0, decided.stderr);

  const completed = cli(["complete", "--id", workId, "--target", target]);
  assert.equal(completed.status, 0, completed.stderr);
  assert.match(completed.stdout, /completed/u);

  const listed = cli(["list", "--target", target]);
  assert.equal(listed.status, 0, listed.stderr);
  assert.match(listed.stdout, /\| done \| completed \|/u);
});

test("engine reconfiguration is also bound to an exact plan hash", () => {
  const target = mkdtempSync(join(tmpdir(), "chartermesh-reconfigure-"));
  const initial = cli(["bootstrap", "--target", target, "--engine", "fake"]);
  const initialHash = initial.stdout.match(/Approval token: ([a-f0-9]{64})/u)?.[1];
  assert.ok(initialHash);
  assert.equal(
    cli([
      "bootstrap",
      "--target",
      target,
      "--engine",
      "fake",
      "--approve",
      initialHash,
    ]).status,
    0,
  );

  const configureArgs = [
    "configure-engine",
    "--target",
    target,
    "--engine",
    "openai-compatible",
    "--endpoint",
    "http://127.0.0.1:11434/v1",
    "--model",
    "local-model",
  ];
  const preview = cli(configureArgs);
  assert.equal(preview.status, 0, preview.stderr);
  const hash = preview.stdout.match(/Approval token: ([a-f0-9]{64})/u)?.[1];
  assert.ok(hash, preview.stdout);
  assert.match(preview.stdout, /verify\/replace/u);

  const applied = cli([...configureArgs, "--approve", hash]);
  assert.equal(applied.status, 0, applied.stderr);
  const runtime = JSON.parse(
    readFileSync(join(target, ".chartermesh", "runtime.json"), "utf8"),
  );
  assert.equal(runtime.modelEngines[0].adapter, "openai-compatible");
  assert.equal(runtime.modelEngines[0].model, "local-model");
});

test("proposal and workflow commands expose versioned JSON for coding agents", () => {
  const target = mkdtempSync(join(tmpdir(), "chartermesh-json-"));
  writeFileSync(join(target, "package.json"), '{"scripts":{"test":"node --test"}}');
  writeFileSync(join(target, "service.ts"), "export const service = true;\n");
  writeFileSync(join(target, "service.test.ts"), "export {};\n");

  const proposed = cli([
    "propose",
    "--target",
    target,
    "--profile",
    "controlled",
    "--json",
  ]);
  assert.equal(proposed.status, 0, proposed.stderr);
  const proposal = JSON.parse(proposed.stdout);
  assert.equal(proposal.apiVersion, "chartermesh.dev/cli/v1alpha1");
  assert.equal(proposal.data.profile, "controlled");
  assert.ok(proposal.data.assessment.detectedLanguages.includes("TypeScript"));
  assert.equal(proposal.data.assessment.hasTests, true);

  const bootstrapArgs = [
    "bootstrap",
    "--target",
    target,
    "--engine",
    "fake",
    "--json",
  ];
  const preview = JSON.parse(cli(bootstrapArgs).stdout);
  assert.equal(preview.data.approvalRequired, true);
  const applied = cli([
    ...bootstrapArgs,
    "--approve",
    preview.data.planHash,
  ]);
  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(JSON.parse(applied.stdout).data.applied, true);

  const requested = cli([
    "request",
    "JSON contract",
    "--summary",
    "Exercise the machine-readable command contract.",
    "--target",
    target,
    "--json",
  ]);
  const requestEnvelope = JSON.parse(requested.stdout);
  assert.equal(requestEnvelope.command, "request");
  assert.match(requestEnvelope.data.id, /^work-\d{6}$/u);

  const listed = JSON.parse(
    cli(["list", "--target", target, "--json"]).stdout,
  );
  assert.equal(listed.data.items.length, 1);

  const evaluated = cli([
    "evaluate-model",
    "--target",
    target,
    "--live",
    "--json",
  ]);
  assert.equal(evaluated.status, 0, evaluated.stdout + evaluated.stderr);
  const evaluationEnvelope = JSON.parse(evaluated.stdout);
  assert.equal(evaluationEnvelope.command, "evaluate-model");
  assert.equal(evaluationEnvelope.data.passedCases, 3);
});
