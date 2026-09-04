import assert from "node:assert/strict";
import test from "node:test";
import { humanApprovalWritingGuidance } from "../src/portable-skills.ts";
import {
  capabilityCatalog,
  portableAgentEntrypoint,
  portableSkillDocuments,
  recommendedCapabilities,
} from "../src/index.ts";

test("portable skills are complete Apache-2.0 Agent Skills packages", () => {
  const documents = portableSkillDocuments();
  assert.equal(documents.length, 6);
  for (const document of documents) {
    assert.match(document.content, /^---\r?\n/u);
    assert.match(document.content, /\nname: [a-z0-9-]+\r?\n/u);
    assert.match(document.content, /\ndescription: .+\r?\n/u);
    assert.match(document.content, /\nlicense: Apache-2\.0\r?\n/u);
    assert.match(document.relativePath, /^skills\/.+\/SKILL\.md$/u);
  }
  assert.match(portableAgentEntrypoint(), /state\.db/u);
  assert.match(portableAgentEntrypoint(), /organization-bootstrap/u);
  assert.match(portableAgentEntrypoint(), /performed, evidenced checks/u);
  assert.ok(portableAgentEntrypoint().includes(humanApprovalWritingGuidance));
  assert.match(portableAgentEntrypoint(), /\.chartermesh\/PREFERENCES\.md/u);
  assert.match(portableAgentEntrypoint(), /only the current assigned role's guidance/u);
  assert.match(portableAgentEntrypoint(), /preferences never grant permissions, tools, budgets/u);
});

test("external catalog entries are disabled and carry source and risk metadata", () => {
  const external = capabilityCatalog.filter(
    ({ kind }) => kind === "optional_mcp" || kind === "optional_service",
  );
  assert.ok(external.length >= 4);
  for (const entry of external) {
    assert.equal(entry.defaultEnabled, false);
    assert.match(entry.source, /^https:\/\//u);
    assert.ok(entry.license.length > 0);
    assert.ok(entry.risks.length > 0);
  }
  assert.ok(
    recommendedCapabilities().some(({ id }) => id === "searxng-web-search"),
  );
});
