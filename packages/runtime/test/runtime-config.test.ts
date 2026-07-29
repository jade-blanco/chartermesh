import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  parseRuntimeConfig,
  validateRuntimeConfigSchema,
} from "../src/index.ts";

const valid = {
  apiVersion: "chartermesh.dev/runtime/v1alpha1",
  modelEngines: [{ id: "model", adapter: "fake" }],
  managedRunners: [
    {
      id: "runner",
      adapter: "builtin-managed-runner",
      modelEngineRef: "model",
    },
  ],
};

test("runtime parser enforces the dependency-free JSON Schema", () => {
  assert.deepEqual(validateRuntimeConfigSchema(valid), []);
  assert.equal(
    parseRuntimeConfig(JSON.stringify(valid)).modelEngines[0]?.id,
    "model",
  );
  assert.throws(
    () =>
      parseRuntimeConfig(
        JSON.stringify({ ...valid, unexpected: "not allowed" }),
      ),
    /additionalProperties/u,
  );
});

test("runtime parser rejects duplicate ids and dangling engine references", () => {
  assert.throws(
    () =>
      parseRuntimeConfig(
        JSON.stringify({
          ...valid,
          modelEngines: [...valid.modelEngines, ...valid.modelEngines],
        }),
      ),
    /must be unique/u,
  );
  assert.throws(
    () =>
      parseRuntimeConfig(
        JSON.stringify({
          ...valid,
          managedRunners: [
            { ...valid.managedRunners[0], modelEngineRef: "missing" },
          ],
        }),
      ),
    /references unknown model engine/u,
  );
});

test("checked-in runtime schema remains readable by the parser", () => {
  const schema = JSON.parse(
    readFileSync("schemas/runtime-config-v1alpha1.schema.json", "utf8"),
  );
  assert.equal(
    schema.$id,
    "urn:chartermesh:schema:runtime-config:v1alpha1",
  );
});
