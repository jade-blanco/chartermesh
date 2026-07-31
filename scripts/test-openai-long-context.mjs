#!/usr/bin/env node

import { request } from "node:http";

const endpoint = new URL(
  process.argv[2] ?? "http://127.0.0.1:18081/v1/chat/completions",
);
const model = process.argv[3] ?? "gemma-4-e4b-it-q4_k_m";
const repeats = Number(process.argv[4] ?? 21_900);
const timeoutMs = Number(process.argv[5] ?? 900_000);
if (!Number.isInteger(repeats) || repeats < 1 || repeats > 100_000) {
  throw new Error("repeats must be an integer from 1 to 100000.");
}
if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000) {
  throw new Error("timeoutMs must be an integer of at least 1000.");
}
const body = JSON.stringify({
  model,
  messages: [
    { role: "system", content: "Answer with OK only." },
    {
      role: "user",
      content: `${"context-token ".repeat(repeats)}\nAnswer OK.`,
    },
  ],
  max_tokens: 8,
  temperature: 0,
  chat_template_kwargs: { enable_thinking: false },
});
const startedAt = Date.now();
const response = await new Promise((resolveResponse, reject) => {
  const outgoing = request(
    endpoint,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
      },
    },
    (incoming) => {
      const chunks = [];
      incoming.on("data", (chunk) => chunks.push(chunk));
      incoming.on("end", () => {
        resolveResponse({
          status: incoming.statusCode,
          text: Buffer.concat(chunks).toString("utf8"),
        });
      });
    },
  );
  outgoing.setTimeout(timeoutMs, () => {
    outgoing.destroy(new Error("LONG_CONTEXT_TIMEOUT"));
  });
  outgoing.on("error", reject);
  outgoing.end(body);
});
let parsed;
try {
  parsed = JSON.parse(response.text);
} catch {
  parsed = { raw: response.text.slice(0, 500) };
}
console.log(
  JSON.stringify(
    {
      status: response.status,
      elapsedMs: Date.now() - startedAt,
      repeats,
      usage: parsed.usage,
      finishReason: parsed.choices?.[0]?.finish_reason,
      content: parsed.choices?.[0]?.message?.content,
      error: parsed.error,
    },
    null,
    2,
  ),
);
