import assert from "node:assert/strict";
import test from "node:test";
import {
  ARTIFACT_CANDIDATE_API_VERSION,
  ARTIFACT_ORACLE_OPERATORS,
  ArtifactCandidateParseError,
  MAX_ARTIFACT_CANDIDATE_BYTES,
  canonicalArtifactJson,
  canonicalArtifactSha256,
  evaluateArtifactOracle,
  parseArtifactCandidate,
  validateArtifactIr,
  type ArtifactOracleRequirement,
} from "../src/workflow-evaluation/artifacts.ts";
import {
  artifactEvaluationSuiteHash,
  artifactEvaluationTaskHash,
  generateReferenceArtifactSuite,
  projectPublicArtifactTask,
  projectSealedArtifactTask,
} from "../src/workflow-evaluation/suite.ts";
import { artifactCandidateResponseSchemaFor } from "../src/workflow-evaluation/artifact-adapters.ts";

function assertParseCode(action: () => unknown, code: string): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof ArtifactCandidateParseError);
    assert.equal(error.code, code);
    return true;
  });
}

test("reference suite contains one fixture for every family and difficulty", () => {
  const first = generateReferenceArtifactSuite();
  const second = generateReferenceArtifactSuite();
  assert.deepEqual(first, second);
  assert.equal(first.length, 15);
  assert.equal(new Set(first.map(({ id }) => id)).size, 15);
  assert.deepEqual(
    Object.fromEntries(
      ["product_package", "research", "xlsx", "docx", "pptx"].map(
        (family) => [
          family,
          Object.fromEntries(
            ["easy", "medium", "hard"].map((difficulty) => [
              difficulty,
              first.filter(
                (task) =>
                  task.family === family && task.difficulty === difficulty,
              ).length,
            ]),
          ),
        ],
      ),
    ),
    {
      product_package: { easy: 1, medium: 1, hard: 1 },
      research: { easy: 1, medium: 1, hard: 1 },
      xlsx: { easy: 1, medium: 1, hard: 1 },
      docx: { easy: 1, medium: 1, hard: 1 },
      pptx: { easy: 1, medium: 1, hard: 1 },
    },
  );
});

test("canonical task and suite commitments cover sealed fixture contents", () => {
  const tasks = generateReferenceArtifactSuite(91);
  for (const task of tasks) {
    assert.equal(task.taskHash, artifactEvaluationTaskHash(task), task.id);
    assert.match(task.taskHash, /^[a-f0-9]{64}$/u);
    assert.equal(task.mutations.length, 3);
    for (const mutation of task.mutations) {
      assert.equal(
        mutation.candidateHash,
        canonicalArtifactSha256(mutation.candidate),
      );
      assert.match(mutation.selectionHash, /^[a-f0-9]{64}$/u);
    }
  }
  assert.equal(
    artifactEvaluationSuiteHash(tasks),
    artifactEvaluationSuiteHash([...tasks].reverse()),
  );
  assert.notEqual(
    artifactEvaluationSuiteHash(tasks),
    artifactEvaluationSuiteHash(generateReferenceArtifactSuite(92)),
  );
  assert.equal(
    canonicalArtifactJson({ z: 1, a: [3, 2, 1] }),
    canonicalArtifactJson({ a: [3, 2, 1], z: 1 }),
  );
  assert.throws(() => canonicalArtifactJson({ unsafe: undefined }));
});

test("all oracle candidates pass and every declared baseline failure is exact", () => {
  for (const task of generateReferenceArtifactSuite()) {
    const oracle = evaluateArtifactOracle(
      task.oracleCandidate.artifact,
      task.oracleRequirements,
    );
    assert.equal(oracle.passed, true, task.id);
    assert.equal(oracle.failedRequirementIds.length, 0, task.id);

    const baseline = evaluateArtifactOracle(
      task.baselineCandidate.artifact,
      task.oracleRequirements,
    );
    assert.equal(baseline.passed, false, task.id);
    assert.deepEqual(
      baseline.failedRequirementIds,
      task.baselineExpectedFailureRequirementIds,
      task.id,
    );
    assert.ok(task.baselineExpectedFailureRequirementIds.length > 0, task.id);
  }
});

test("seeded valid mutations achieve at least a 95 percent kill rate", () => {
  const tasks = generateReferenceArtifactSuite(20260731);
  let mutations = 0;
  let killed = 0;
  for (const task of tasks) {
    for (const mutation of task.mutations) {
      mutations += 1;
      const parsed = parseArtifactCandidate(
        JSON.stringify(mutation.candidate),
        { taskId: task.id, family: task.family },
      );
      const result = evaluateArtifactOracle(
        parsed.artifact,
        task.oracleRequirements,
      );
      if (!result.passed) killed += 1;
    }
  }
  assert.equal(mutations, 45);
  assert.ok(killed / mutations >= 0.95, `${killed}/${mutations}`);
});

test("public projection preflight excludes all sealed evaluator material", () => {
  for (const task of generateReferenceArtifactSuite()) {
    const projection = projectPublicArtifactTask(task);
    const encoded = JSON.stringify(projection);
    assert.equal(projection.outputContract.semanticGateOnly, true);
    assert.equal(projection.outputContract.artifactKind, task.family);
    assert.equal(projection.outputContract.maximumBytes, 256 * 1024);
    for (const forbiddenKey of [
      "oracleRequirements",
      "oracleCandidate",
      "baselineCandidate",
      "baselineExpectedFailureRequirementIds",
      "mutations",
      "taskHash",
      "candidateHash",
      "selectionHash",
    ]) {
      assert.equal(
        encoded.includes(`\"${forbiddenKey}\"`),
        false,
        `${task.id}:${forbiddenKey}`,
      );
    }
    for (const requirement of task.oracleRequirements) {
      assert.equal(
        encoded.includes(JSON.stringify(requirement.id)),
        false,
        `${task.id}:${requirement.id}`,
      );
    }
    for (const mutation of task.mutations) {
      assert.equal(encoded.includes(mutation.id), false, mutation.id);
      assert.equal(
        encoded.includes(mutation.description),
        false,
        mutation.description,
      );
      assert.equal(encoded.includes(mutation.selectionHash), false);
    }

    const sealed = projectSealedArtifactTask(task);
    assert.equal(sealed.taskHash, task.taskHash);
    assert.deepEqual(sealed.publicTask, projection);
    assert.equal(sealed.oracleRequirements.length > 0, true);

    projection.publicInstructions.push("tamper");
    sealed.oracleRequirements.length = 0;
    assert.equal(task.publicInstructions.includes("tamper"), false);
    assert.equal(task.oracleRequirements.length > 0, true);
  }
});

test("candidate parser accepts one bounded JSON envelope and fails closed", () => {
  const task = generateReferenceArtifactSuite()[0]!;
  const source = JSON.stringify(task.oracleCandidate, null, 2);
  const parsed = parseArtifactCandidate(source, {
    taskId: task.id,
    family: task.family,
  });
  assert.equal(
    canonicalArtifactSha256(parsed),
    canonicalArtifactSha256(task.oracleCandidate),
  );

  assertParseCode(
    () => parseArtifactCandidate(`\`\`\`json\n${source}\n\`\`\``),
    "CANDIDATE_NOT_JSON",
  );
  assertParseCode(
    () =>
      parseArtifactCandidate(
        `{"apiVersion":"${ARTIFACT_CANDIDATE_API_VERSION}","taskId":"one","taskId":"two","artifact":{}}`,
      ),
    "CANDIDATE_DUPLICATE_KEY",
  );
  assertParseCode(
    () => parseArtifactCandidate(`${source}\nexplanation`),
    "CANDIDATE_NOT_JSON",
  );
  assertParseCode(
    () => parseArtifactCandidate(`{"padding":"${"x".repeat(MAX_ARTIFACT_CANDIDATE_BYTES)}"}`),
    "CANDIDATE_TOO_LARGE",
  );
  const withExtra = JSON.parse(source) as Record<string, unknown>;
  withExtra.commentary = "not allowed";
  assertParseCode(
    () => parseArtifactCandidate(JSON.stringify(withExtra)),
    "CANDIDATE_SCHEMA_INVALID",
  );
  assertParseCode(
    () => parseArtifactCandidate(source, { taskId: "different-task" }),
    "CANDIDATE_SCHEMA_INVALID",
  );
});

test("IR validation is discriminated and office artifacts remain semantic gates", () => {
  const tasks = generateReferenceArtifactSuite();
  for (const task of tasks) {
    assert.equal(validateArtifactIr(task.oracleCandidate.artifact).kind, task.family);
  }
  const document = structuredClone(
    tasks.find(({ family }) => family === "docx")!.oracleCandidate.artifact,
  ) as unknown as Record<string, unknown>;
  const sections = document.sections as Array<Record<string, unknown>>;
  const blocks = sections[0]!.blocks as Array<Record<string, unknown>>;
  blocks[0] = { type: "video", src: "https://example.invalid" };
  assert.throws(() => validateArtifactIr(document), /type is invalid/u);

  for (const family of ["xlsx", "docx", "pptx"] as const) {
    const projection = projectPublicArtifactTask(
      tasks.find((task) => task.family === family)!,
    );
    assert.equal(projection.outputContract.semanticGateOnly, true);
    assert.match(projection.publicInstructions.join(" "), /IR only/u);
  }
});

test("oracle evaluation exposes only a fixed safe operator allowlist", () => {
  assert.deepEqual(ARTIFACT_ORACLE_OPERATORS, [
    "exists",
    "equals",
    "contains",
    "min_items",
    "max_items",
    "unique_by",
    "number_at_least",
    "string_includes",
  ]);
  assert.equal(
    ARTIFACT_ORACLE_OPERATORS.some((operator) =>
      ["eval", "script", "regex", "shell"].includes(operator),
    ),
    false,
  );
  const task = generateReferenceArtifactSuite()[0]!;
  const first = evaluateArtifactOracle(
    task.oracleCandidate.artifact,
    task.oracleRequirements,
  );
  const second = evaluateArtifactOracle(
    task.oracleCandidate.artifact,
    structuredClone(task.oracleRequirements),
  );
  assert.deepEqual(first, second);

  const forged = [
    { id: "unsafe", path: "", operator: "script", expected: "true" },
  ] as unknown as ArtifactOracleRequirement[];
  assert.throws(
    () => evaluateArtifactOracle(task.oracleCandidate.artifact, forged),
    /allowlisted/u,
  );
});

test("every live response schema is task-bound and recursively closes object fields", () => {
  const visit = (value: unknown, path: string): void => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const node = value as Record<string, unknown>;
    if (node.type === "object") {
      assert.equal(
        node.additionalProperties,
        false,
        `${path} must reject undeclared fields`,
      );
      assert.ok(Array.isArray(node.required), `${path} must declare required keys`);
    }
    for (const [key, child] of Object.entries(node)) {
      if (key === "const") continue;
      if (Array.isArray(child)) {
        child.forEach((item, index) => visit(item, `${path}.${key}[${index}]`));
      } else {
        visit(child, `${path}.${key}`);
      }
    }
  };

  for (const task of generateReferenceArtifactSuite()) {
    const schema = artifactCandidateResponseSchemaFor({
      id: task.id,
      family: task.family,
    });
    const properties = schema.properties as Record<string, Record<string, unknown>>;
    assert.equal(properties.taskId?.const, task.id);
    const artifact = properties.artifact as Record<string, unknown>;
    const artifactProperties = artifact.properties as Record<
      string,
      Record<string, unknown>
    >;
    assert.equal(artifactProperties.kind?.const, task.family);
    visit(schema, task.id);
  }
});
