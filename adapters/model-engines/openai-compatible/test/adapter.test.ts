import assert from "node:assert/strict";
import test from "node:test";
import {
  OpenAICompatibleModelEngine,
  validateOpenAICompatibleConfig,
} from "../src/index.ts";

test("configuration keeps credentials in environment indirection", () => {
  const issues = validateOpenAICompatibleConfig(
    {
      id: "remote",
      endpoint: "https://models.example/v1",
      model: "example-model",
      apiKeyEnv: "EXAMPLE_MODEL_KEY",
    },
    {},
  );
  assert.deepEqual(issues, [
    "Environment variable 'EXAMPLE_MODEL_KEY' is not set.",
  ]);
});

test("adapter normalizes an OpenAI-compatible response", async () => {
  let authorization = "";
  const engine = new OpenAICompatibleModelEngine(
    {
      id: "remote",
      endpoint: "https://models.example/v1",
      model: "example-model",
      apiKeyEnv: "EXAMPLE_MODEL_KEY",
    },
    { EXAMPLE_MODEL_KEY: "test-only-secret" },
    async (_url, init) => {
      authorization = new Headers(init?.headers).get("authorization") ?? "";
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: { content: "Synthetic provider response" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 12, completion_tokens: 5 },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    },
  );
  const result = await engine.generate({
    invocationId: "invocation-test",
    messages: [{ role: "user", content: "Hello" }],
  });

  assert.equal(authorization, "Bearer test-only-secret");
  assert.equal(result.text, "Synthetic provider response");
  assert.equal(result.usage.inputTokens, 12);
  assert.equal(result.usage.outputTokens, 5);
});
