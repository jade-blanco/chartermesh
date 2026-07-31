import assert from "node:assert/strict";
import test from "node:test";
import {
  compileStructuredArtifact,
  extractFirstJsonObject,
  parseStructuredArtifact,
} from "../src/index.ts";

test("artifact compiler produces schema-valid envelopes for 300 varied outputs", () => {
  const inputs = Array.from({ length: 300 }, (_, index) => {
    if (index % 17 === 0) return "";
    if (index % 11 === 0) {
      return `\u0000# Result ${index}\n${"bounded text ".repeat(2_000)}`;
    }
    if (index % 7 === 0) {
      return `\`\`\`json\n{"sentinel":"STRUCT-${index}"}\n\`\`\``;
    }
    return `Result ${index}\nSentinel STRUCT-${index} retained.`;
  });
  for (const input of inputs) {
    const compiled = compileStructuredArtifact({ text: input });
    assert.notEqual(parseStructuredArtifact(compiled.canonicalText), null);
    assert.equal(compiled.artifact.deliverable.length <= 20_000, true);
  }
});

test("JSON extractor ignores prose and braces inside strings", () => {
  assert.deepEqual(
    extractFirstJsonObject(
      'Explanation first.\n```json\n{"message":"a } brace","nested":{"ok":true}}\n```',
    ),
    { message: "a } brace", nested: { ok: true } },
  );
  assert.equal(extractFirstJsonObject("no object"), undefined);
});
