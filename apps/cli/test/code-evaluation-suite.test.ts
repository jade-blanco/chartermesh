import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import {
  codeEvaluationSuiteHash,
  codeEvaluationTaskHash,
  generatePilotCodeSuite,
  projectPublicCodeTask,
  type CodeTestCase,
} from "../src/code-evaluation/suite.ts";
import { buildCodeTaskPrompt } from "../src/code-evaluation/candidate.ts";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function assertJsonSafe(value: unknown): void {
  const encoded = JSON.stringify(value);
  assert.notEqual(encoded, undefined);
  assert.deepEqual(JSON.parse(encoded!), value);
}

function hasExpected(testCase: CodeTestCase): boolean {
  return Object.hasOwn(testCase, "expected");
}

test("pilot suite deterministically contains two tasks for each repository", () => {
  const first = generatePilotCodeSuite();
  const second = generatePilotCodeSuite();
  assert.deepEqual(first, second);
  assert.equal(first.length, 6);
  assert.equal(new Set(first.map(({ id }) => id)).size, 6);
  assert.deepEqual(
    Object.fromEntries(
      [...new Set(first.map(({ repositoryId }) => repositoryId))]
        .sort()
        .map((repositoryId) => [
          repositoryId,
          first.filter((task) => task.repositoryId === repositoryId)
            .length,
        ]),
    ),
    {
      "equipment-desk": 2,
      "settlement-pipeline": 2,
      "work-order-ledger": 2,
    },
  );
  assert.match(codeEvaluationSuiteHash(first), /^[a-f0-9]{64}$/u);
  assert.equal(
    codeEvaluationSuiteHash(first),
    codeEvaluationSuiteHash([...first].reverse()),
  );
});

test("task and mutation commitments match their complete contents", () => {
  const tasks = generatePilotCodeSuite(17);
  for (const task of tasks) {
    assert.equal(task.taskHash, codeEvaluationTaskHash(task), task.id);
    assert.deepEqual(task.editablePaths, ["solution.mjs"], task.id);
    assert.equal(task.mutations.length, 3, task.id);
    const solution = task.baseFiles.find(
      ({ path }) => path === "solution.mjs",
    );
    assert.ok(solution, task.id);
    for (const file of task.baseFiles) {
      assert.equal(file.sha256, sha256(file.content), file.path);
    }
    assert.notEqual(solution.content, task.oracleContent, task.id);
    for (const mutation of task.mutations) {
      assert.equal(
        mutation.contentHash,
        sha256(mutation.content),
        mutation.id,
      );
      assert.notEqual(mutation.content, task.oracleContent, mutation.id);
      assert.notEqual(mutation.content, solution.content, mutation.id);
      assert.match(mutation.selectionHash, /^[a-f0-9]{64}$/u);
    }
  }
  assert.notEqual(
    codeEvaluationSuiteHash(tasks),
    codeEvaluationSuiteHash(generatePilotCodeSuite(18)),
  );
});

test("cases are JSON-safe, exclusive, and declare baseline hidden failures", () => {
  for (const task of generatePilotCodeSuite()) {
    assert.ok(task.publicCases.length >= 2, task.id);
    assert.ok(task.hiddenCases.length >= 4, task.id);
    const hiddenIds = new Set(task.hiddenCases.map(({ id }) => id));
    assert.ok(task.baselineExpectedFailureCaseIds.length > 0, task.id);
    for (const id of task.baselineExpectedFailureCaseIds) {
      assert.equal(hiddenIds.has(id), true, `${task.id}:${id}`);
    }
    for (const testCase of [...task.publicCases, ...task.hiddenCases]) {
      assertJsonSafe(testCase);
      assert.notEqual(
        hasExpected(testCase),
        Object.hasOwn(testCase, "expectedErrorCode"),
        `${task.id}:${testCase.id}`,
      );
    }
  }
});

test("public projection excludes hidden tests, oracle, mutations, and commitments", () => {
  for (const task of generatePilotCodeSuite()) {
    const projection = projectPublicCodeTask(task);
    const encoded = JSON.stringify(projection);
    assertJsonSafe(projection);
    assert.deepEqual(projection.editablePaths, ["solution.mjs"]);
    assert.match(
      projection.prompt,
      /complete replacement text for solution\.mjs only/u,
    );
    for (const forbidden of [
      "hiddenCases",
      "oracleContent",
      "mutations",
      "baselineExpectedFailureCaseIds",
      "taskHash",
      "selectionHash",
    ]) {
      assert.equal(encoded.includes(`"${forbidden}"`), false, forbidden);
    }
    for (const hiddenCase of task.hiddenCases) {
      assert.equal(encoded.includes(hiddenCase.id), false, hiddenCase.id);
    }
  }
});

test("candidate prompt preserves public error examples without leaking hidden cases", () => {
  const task = generatePilotCodeSuite().find(({ publicCases }) =>
    publicCases.some((testCase) =>
      Object.hasOwn(testCase, "expectedErrorCode")
    )
  );
  assert.ok(task);
  const projection = projectPublicCodeTask(task);
  const prompt = buildCodeTaskPrompt(projection);
  const publicError = projection.publicCases.find((testCase) =>
    Object.hasOwn(testCase, "expectedErrorCode")
  );
  assert.ok(publicError);
  assert.match(prompt, new RegExp(publicError.id, "u"));
  assert.match(
    prompt,
    new RegExp(
      (publicError as { expectedErrorCode: string }).expectedErrorCode,
      "u",
    ),
  );
  for (const hiddenCase of task.hiddenCases) {
    assert.equal(prompt.includes(hiddenCase.id), false, hiddenCase.id);
  }
});

test("all candidate modules expose the fixed solve contract as plain source", () => {
  for (const task of generatePilotCodeSuite()) {
    const baseline = task.baseFiles.find(
      ({ path }) => path === "solution.mjs",
    )!.content;
    for (const [label, content] of [
      ["baseline", baseline],
      ["oracle", task.oracleContent],
      ...task.mutations.map(
        (mutation) => [mutation.id, mutation.content] as const,
      ),
    ]) {
      assert.match(
        content,
        /export function solve\(input\)/u,
        `${task.id}:${label}`,
      );
      assert.doesNotMatch(
        content,
        /\b(?:fetch|child_process|worker_threads)\b/u,
        `${task.id}:${label}`,
      );
    }
  }
});
