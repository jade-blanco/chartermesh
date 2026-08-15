import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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

test("runtime parser validates optional web search security bounds", () => {
  const parsed = parseRuntimeConfig(
    JSON.stringify({
      ...valid,
      webSearch: {
        adapter: "searxng",
        endpoint: "http://127.0.0.1:8888/search",
        timeoutMs: 20_000,
        maxResults: 8,
        maxResponseBytes: 1_048_576,
      },
    }),
  );
  assert.equal(parsed.webSearch?.adapter, "searxng");
  assert.throws(
    () =>
      parseRuntimeConfig(
        JSON.stringify({
          ...valid,
          webSearch: {
            adapter: "searxng",
            endpoint: "http://public.example/search",
          },
        }),
      ),
    /HTTPS or loopback HTTP/u,
  );
});

test("runtime parser validates optional pinned agent hosts", () => {
  const parsed = parseRuntimeConfig(
    JSON.stringify({
      ...valid,
      agentHosts: [
        {
          id: "codex-local",
          adapter: "codex-app-server",
          command: resolve("codex"),
          executableSha256: "a".repeat(64),
          args: ["--profile", "chartermesh"],
          model: "gpt-5.6-terra",
          reasoningEffort: "medium",
          allowUnrestrictedRead: true,
          timeoutMs: 120_000,
        },
      ],
    }),
  );
  assert.equal(parsed.agentHosts?.[0]?.adapter, "codex-app-server");
  assert.deepEqual(parsed.agentHosts?.[0]?.args, ["--profile", "chartermesh"]);
  assert.throws(
    () =>
      parseRuntimeConfig(
        JSON.stringify({
          ...valid,
          agentHosts: [
            {
              id: "model",
              adapter: "codex-app-server",
              command: resolve("codex"),
              executableSha256: "a".repeat(64),
            },
          ],
        }),
      ),
    /unique across adapter kinds/u,
  );
  assert.throws(
    () =>
      parseRuntimeConfig(
        JSON.stringify({
          ...valid,
          agentHosts: [
            {
              id: "codex-local",
              adapter: "codex-app-server",
              command: resolve("codex"),
              executableSha256: "unpinned",
            },
          ],
        }),
      ),
    /pattern/u,
  );
  assert.throws(
    () =>
      parseRuntimeConfig(
        JSON.stringify({
          ...valid,
          agentHosts: [
            {
              id: "codex-local",
              adapter: "codex-app-server",
              command: "codex",
              executableSha256: "a".repeat(64),
            },
          ],
        }),
      ),
    /absolute executable path/u,
  );
});
