import assert from "node:assert/strict";
import test from "node:test";
import type { TeamDesign } from "../src/proposal.ts";
import { renderTeamCharter } from "../src/team-charter.ts";

const controlledTeam: TeamDesign = {
  template: "software-product",
  source: "explicit",
  entryRole: "operator",
  roles: [
    {
      id: "coordinator",
      name: "Product Coordinator",
      class: "c_level",
      mission: "Turn the approved objective into bounded product decisions.",
      capabilities: ["work_coordination", "decision_synthesis"],
    },
    {
      id: "operator",
      name: "Product Builder",
      class: "worker",
      mission: "Implement and document the approved product scope.",
      capabilities: ["artifact_generation"],
    },
    {
      id: "verifier",
      name: "Product Verifier",
      class: "reviewer",
      mission: "Verify evidence against the acceptance criteria.",
      capabilities: ["artifact_verification"],
    },
  ],
  stages: [
    {
      id: "coordinate",
      name: "Coordinate",
      type: "agent",
      owner: "coordinator",
      dependsOn: [],
    },
    {
      id: "produce",
      name: "Produce",
      type: "agent",
      owner: "operator",
      dependsOn: ["coordinate"],
    },
    {
      id: "verify",
      name: "Verify",
      type: "agent",
      owner: "verifier",
      dependsOn: ["produce"],
    },
    {
      id: "review",
      name: "Human review",
      type: "approval",
      owner: "human",
      dependsOn: ["verify"],
    },
  ],
  executionBoundary: "manual_handoffs_until_workflow_runtime_binding",
};

const hash = "0123456789abcdef".repeat(4);

test("team charter is deterministic and includes the complete one-shot operating contract", () => {
  const input = {
    projectTitle: "Neighborhood pantry tracker",
    briefHash: hash,
    profile: "controlled" as const,
    teamDesign: controlledTeam,
    approvalRequiredTools: ["workspace.write_file", "web.search"],
  };
  const first = renderTeamCharter(input);
  const second = renderTeamCharter(input);

  assert.equal(first, second);
  for (const section of [
    "## Mission and immutable reference",
    "## Roles and responsibilities",
    "## Work allocation and operating rules",
    "## Copy/paste inter-team handoffs",
    "## Human approval matrix",
    "## Execution boundary",
  ]) {
    assert.match(first, new RegExp(section.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  }
  assert.match(first, /`coordinator`/u);
  assert.match(first, /`operator`/u);
  assert.match(first, /`verifier`/u);
  assert.match(first, /FROM_ROLE: coordinator/u);
  assert.match(first, /TO_ROLE: operator/u);
  assert.match(first, /FROM_ROLE: operator/u);
  assert.match(first, /TO_ROLE: verifier/u);
  assert.match(first, /\[CHARTERMESH HANDOFF\]/u);
  assert.match(first, /\[CHARTERMESH APPROVAL REQUEST\]/u);
  assert.match(first, /APPROVE_EXACT_HASH/u);
  assert.match(first, /workspace\.write_file/u);
  assert.match(first, /Required for the exact tool call/u);
  assert.match(first, /Model review.*cannot/iu);
  assert.match(first, /does not by itself execute provider-native agents/iu);
  assert.match(first, /stage handoffs remain explicit copy\/paste consultations/iu);
  assert.match(first, /one initial WorkItem owned by/iu);
});

test("team charter only renders sanitized metadata and ignores an attached raw brief", () => {
  const privateLinuxPath = ["", "home", "alice", "private", "plan.md"].join("/");
  const privateBrief =
    "PRIVATE BRIEF: Alice can be reached at alice@example.com and her password=hunter2.";
  const input = {
    projectTitle:
      "Alice alice@example.com C:\\Users\\Alice\\private\\plan.md ghp_1234567890abcdefghijklmnop",
    briefHash: hash,
    profile: "controlled" as const,
    teamDesign: {
      ...controlledTeam,
      roles: controlledTeam.roles.map((role, index) =>
        index === 0
          ? {
              ...role,
              mission: `Read ${privateLinuxPath} using api_key=topsecretvalue.`,
            }
          : role,
      ),
    },
    approvalRequiredTools: ["workspace.write_file"],
    rawBrief: privateBrief,
  };
  const charter = renderTeamCharter(input);

  assert.doesNotMatch(charter, /alice@example\.com/iu);
  assert.doesNotMatch(charter, /C:\\Users\\Alice/iu);
  assert.equal(charter.includes(privateLinuxPath), false);
  assert.doesNotMatch(charter, /hunter2|topsecretvalue|ghp_1234567890/iu);
  assert.doesNotMatch(charter, /PRIVATE BRIEF/u);
  assert.match(charter, /\[redacted-path\]/u);
  assert.match(charter, new RegExp(hash, "u"));
});

test("human approval requests start with everyday language without losing exact evidence", () => {
  const charter = renderTeamCharter({
    projectTitle: "이웃 식료품 나눔",
    briefHash: hash,
    profile: "controlled",
    teamDesign: controlledTeam,
    approvalRequiredTools: ["workspace.write_file"],
  });
  assert.match(charter, /in the user's language/u);
  assert.match(charter, /understandable without technical experience/u);
  assert.match(charter, /Be respectful, not childish/u);
  assert.match(charter, /never turn an unknown into 'free', 'safe', or 'reversible'/u);
  const packet = charter.split("[CHARTERMESH APPROVAL REQUEST]")[1]!
    .split("[END CHARTERMESH APPROVAL REQUEST]")[0]!;
  for (const label of [
    "What you are deciding:", "Why this matters:", "If you approve:",
    "What the model says:", "What was checked:", "Cost and data:",
    "Risks and missing information:", "If you say no or wait:",
    "Can we undo it?:", "Your options:",
  ]) {
    assert.ok(packet.includes(label), label);
    assert.ok(packet.indexOf(label) < packet.indexOf("TECHNICAL DETAILS"));
  }
  for (const field of [
    "PROJECT_REF:", "WORK_ITEM_ID:", "REQUESTING_ROLE:",
    "DECISION_REQUIRED:", "OPTIONS:", "RECOMMENDATION_AND_REASON:",
    "USER_VISIBLE_IMPACT:", "EVIDENCE_REFS:", "KNOWN_RISKS:",
    "DECISION_PACKET_HASH:", "APPROVE_EXACT_HASH:",
  ]) {
    assert.ok(packet.includes(field), field);
  }
  assert.ok(packet.includes(`PROJECT_REF: sha256:${hash}`));
  assert.match(packet, /label unverified claims/u);
  assert.match(packet, /say when nothing was checked/u);
});

test("team charter withholds spaced paths and bearer or JWT-like title material", () => {
  const riskyTitle = [
    "Launch",
    ["C:", "Users", "Alice Smith", "Top Secret", "plan.md"].join("\\"),
    "Bearer eyJhbGciOiJIUzI1NiJ9.payloadpayload.signature",
  ].join(" ");
  const charter = renderTeamCharter({
    projectTitle: riskyTitle,
    briefHash: hash,
    profile: "controlled",
    teamDesign: controlledTeam,
    approvalRequiredTools: ["workspace.write_file"],
  });
  assert.doesNotMatch(charter, /Alice Smith|Top Secret|eyJhbGci|payloadpayload/iu);
  assert.match(charter, /\[redacted-path\]/u);
});

test("team charter provides a reusable packet when the design has no peer transition", () => {
  const leanTeam: TeamDesign = {
    ...controlledTeam,
    template: "research",
    roles: [controlledTeam.roles[1]!],
    stages: [
      {
        id: "produce",
        name: "Research",
        type: "agent",
        owner: "operator",
        dependsOn: [],
      },
      {
        id: "review",
        name: "Human review",
        type: "approval",
        owner: "human",
        dependsOn: ["produce"],
      },
    ],
  };
  const charter = renderTeamCharter({
    projectTitle: "Market evidence note",
    briefHash: hash,
    profile: "lean",
    teamDesign: leanTeam,
    approvalRequiredTools: ["workspace.write_file"],
  });

  assert.match(charter, /Reusable role-to-role packet/u);
  assert.match(charter, /FROM_ROLE: &lt;sending role ID&gt;/u);
  assert.match(charter, /TO_ROLE: &lt;receiving role ID&gt;/u);
});
