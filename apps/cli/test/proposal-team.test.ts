import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { RuntimeManifestSet } from "../../../packages/adapter-sdk/src/types.ts";
import {
  parseOrgSpec,
  validateOrgSpec,
} from "../../../packages/orgspec/src/index.ts";
import {
  createProposal,
  organizationFor,
  TEAM_DESIGNS,
  type ProposalProfile,
  type TeamTemplateId,
} from "../src/proposal.ts";

const runtimeManifests: RuntimeManifestSet = {
  modelEngines: [
    {
      kind: "model_engine",
      profileId: "primary-model",
      adapter: "configured-at-runtime",
      contractVersion: "v1alpha1",
      capabilities: [
        {
          name: "model.text.generate",
          support: "native",
          stability: "stable",
        },
      ],
    },
  ],
  agentHosts: [],
  managedRunners: [
    {
      kind: "managed_runner",
      profileId: "local-runner",
      adapter: "builtin-managed-runner",
      contractVersion: "v1alpha1",
      permissionCeiling: "workspace_write",
      engineBinding: "injectable",
      capabilities: [],
    },
  ],
};

function fixtureTarget(name = "software-research-fixture"): string {
  const root = mkdtempSync(join(tmpdir(), "chartermesh-team-proposal-"));
  const target = join(root, name);
  mkdirSync(join(target, "src"), { recursive: true });
  writeFileSync(join(target, "package.json"), "{}\n", "utf8");
  writeFileSync(join(target, "src", "index.ts"), "export {};\n", "utf8");
  return target;
}

function assertValidOrganization(organization: unknown): void {
  const parsed = parseOrgSpec(JSON.stringify(organization));
  const result = validateOrgSpec(parsed, runtimeManifests);
  assert.equal(result.ok, true, JSON.stringify(result.issues, null, 2));
}

test("omitting teamTemplate preserves the legacy organization and proposal shape", () => {
  const proposal = createProposal(fixtureTarget(), "balanced");

  assert.equal("teamDesign" in proposal, false);
  assert.deepEqual(
    proposal.organization.spec.roles.map(({ id, name }) => ({ id, name })),
    [{ id: "operator", name: "Operator" }],
  );
  assert.deepEqual(
    proposal.organization.spec.workflows[0]?.stages.map(({ id }) => id),
    ["produce", "review"],
  );
  assert.equal(
    proposal.organization.spec.workflows[0]?.name,
    "Reviewed Work",
  );
  assert.deepEqual(proposal.rationale, [
    "Selected the balanced operating profile.",
    "Kept external web search disabled by default.",
    "Detected 2 reviewable files without reading file contents.",
    "Detected languages: TypeScript.",
    "No deployment or infrastructure automation signal was detected.",
  ]);
  assert.equal(
    proposal.proposalHash,
    "97f421533603be55bd473e5d1f92e487f9136e58da9e8cda93daf26f97e21189",
  );
  assertValidOrganization(proposal.organization);
});

test("an explicit template shapes lean, balanced, and controlled teams", () => {
  const target = fixtureTarget("profile-fixture");
  const expected: Record<
    ProposalProfile,
    { roles: string[]; stages: string[]; coordinateOwner: string }
  > = {
    lean: {
      roles: ["operator"],
      stages: ["coordinate", "produce", "review"],
      coordinateOwner: "operator",
    },
    balanced: {
      roles: ["coordinator", "operator"],
      stages: ["coordinate", "produce", "review"],
      coordinateOwner: "coordinator",
    },
    controlled: {
      roles: ["coordinator", "operator", "verifier"],
      stages: ["coordinate", "produce", "verify", "review"],
      coordinateOwner: "coordinator",
    },
  };

  for (const profile of ["lean", "balanced", "controlled"] as const) {
    const proposal = createProposal(target, profile, {
      teamTemplate: "software-product",
    });
    const design = proposal.teamDesign;
    assert.ok(design);
    assert.equal(design.template, "software-product");
    assert.equal(design.source, "explicit");
    assert.equal(design.entryRole, "operator");
    assert.equal(
      design.executionBoundary,
      "manual_handoffs_until_workflow_runtime_binding",
    );
    assert.deepEqual(
      design.roles.map(({ id }) => id),
      expected[profile].roles,
    );
    assert.deepEqual(
      design.stages.map(({ id }) => id),
      expected[profile].stages,
    );
    assert.equal(design.stages[0]?.owner, expected[profile].coordinateOwner);
    assert.equal(
      proposal.organization.spec.roles.find(({ id }) => id === "operator")
        ?.name,
      "Software Product Operator",
    );
    assert.equal(
      proposal.organization.spec.workflows[0]?.name,
      "Software Product Delivery Review",
    );
    assert.match(proposal.rationale.join("\n"), /sanitized team template/u);
    assertValidOrganization(proposal.organization);

    const coordinator = proposal.organization.spec.roles.find(
      ({ id }) => id === "coordinator",
    );
    if (profile === "lean") {
      assert.equal(coordinator, undefined);
    } else {
      assert.equal(coordinator?.class, "c_level");
      assert.equal(coordinator?.tools.allow.includes("workspace.write_file"), false);
    }
  }
});

test("explicit template designs are distinct and deterministic without free-text inference", () => {
  const target = fixtureTarget();
  const templates = Object.keys(TEAM_DESIGNS) as TeamTemplateId[];
  const hashes = new Set<string>();
  const operatorNames = new Set<string>();
  const workflowNames = new Set<string>();

  for (const teamTemplate of templates) {
    const first = createProposal(target, "controlled", { teamTemplate });
    const second = createProposal(target, "controlled", { teamTemplate });
    assert.deepEqual(first, second);
    assert.equal(first.proposalHash, second.proposalHash);
    hashes.add(first.proposalHash);
    operatorNames.add(
      first.organization.spec.roles.find(({ id }) => id === "operator")!.name,
    );
    workflowNames.add(first.organization.spec.workflows[0]!.name);
    assertValidOrganization(first.organization);
  }

  assert.equal(hashes.size, templates.length);
  assert.equal(operatorNames.size, templates.length);
  assert.equal(workflowNames.size, templates.length);

  const assessment = createProposal(target, "balanced").assessment;
  const unselected = organizationFor("balanced", assessment);
  assert.equal(unselected.spec.roles[0]?.name, "Operator");
  assert.equal(unselected.spec.workflows[0]?.name, "Reviewed Work");
});
