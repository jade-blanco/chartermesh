import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { RuntimeManifestSet } from "../../adapter-sdk/src/types.ts";
import {
  OrgSpecParseError,
  parseOrgSpec,
  validateOrgSpec,
} from "../src/index.ts";
import type { OrganizationSpec } from "../src/types.ts";
import { loadOrganization, runtimeManifests } from "./fixtures.ts";

function codes(
  candidate: OrganizationSpec,
  manifests: RuntimeManifestSet = runtimeManifests,
) {
  return validateOrgSpec(candidate, manifests).issues.map(({ code }) => code);
}

test("schema and synthetic organization use v1alpha1", async () => {
  const schemaUrl = new URL(
    "../../../schemas/orgspec-v1alpha1.schema.json",
    import.meta.url,
  );
  const schema = JSON.parse(await readFile(schemaUrl, "utf8")) as {
    $schema: string;
    properties: { apiVersion: { const: string } };
    $defs: {
      spec: {
        required: string[];
        properties: Record<string, unknown>;
      };
    };
  };
  const organization = await loadOrganization();

  assert.equal(
    schema.$schema,
    "https://json-schema.org/draft/2020-12/schema",
  );
  assert.equal(schema.properties.apiVersion.const, "chartermesh.dev/v1alpha1");
  assert.equal(organization.apiVersion, "chartermesh.dev/v1alpha1");
  assert.ok(schema.$defs.spec.required.includes("modelEngines"));
  assert.ok(schema.$defs.spec.required.includes("executionTargets"));
  assert.equal("providers" in schema.$defs.spec.properties, false);
});

test("dependency-free parser and semantic validator accept the fixture", async () => {
  const fixtureUrl = new URL(
    "../../../examples/balanced-software-team/organization.json",
    import.meta.url,
  );
  const parsed = parseOrgSpec(await readFile(fixtureUrl, "utf8"));
  const result = validateOrgSpec(parsed, runtimeManifests);

  assert.equal(result.ok, true, JSON.stringify(result.issues, null, 2));
});

test("parser enforces the machine-readable schema before semantic validation", async () => {
  const fixtureUrl = new URL(
    "../../../examples/balanced-software-team/organization.json",
    import.meta.url,
  );
  const candidate = JSON.parse(await readFile(fixtureUrl, "utf8")) as Record<
    string,
    unknown
  >;
  candidate.unexpected = true;
  assert.throws(
    () => parseOrgSpec(JSON.stringify(candidate)),
    (error: unknown) =>
      error instanceof OrgSpecParseError &&
      error.message.includes("/unexpected [additionalProperties]"),
  );

  const wrongType = structuredClone(candidate);
  delete wrongType.unexpected;
  (wrongType.metadata as Record<string, unknown>).revision = "one";
  assert.throws(
    () => parseOrgSpec(JSON.stringify(wrongType)),
    (error: unknown) =>
      error instanceof OrgSpecParseError &&
      error.message.includes("/metadata/revision [type]"),
  );
});

test("reference integrity rejects unknown execution targets and roles", async () => {
  const candidate = structuredClone(await loadOrganization());
  candidate.spec.roles[0]!.execution.preferred = "missing-target";
  candidate.spec.workflows[0]!.stages[0]!.role = "missing-role";

  assert.ok(codes(candidate).includes("UNKNOWN_EXECUTION_TARGET"));
  assert.ok(codes(candidate).includes("STAGE_ROLE_REQUIRED"));
});

test("workflow cycles are rejected", async () => {
  const candidate = structuredClone(await loadOrganization());
  candidate.spec.workflows[0]!.stages[0]!.dependsOn = ["close"];

  assert.ok(codes(candidate).includes("WORKFLOW_CYCLE"));
});

test("external side effects require a distinct execution approval", async () => {
  const candidate = structuredClone(await loadOrganization());
  const stage = candidate.spec.workflows[0]!.stages[0]!;
  stage.externalSideEffect = true;
  stage.executionApprovalRequired = false;

  assert.ok(codes(candidate).includes("SIDE_EFFECT_APPROVAL_REQUIRED"));
});

test("controller schedules must skip without starting a model", async () => {
  const candidate = structuredClone(await loadOrganization());
  candidate.spec.schedules[0]!.noWorkBehavior = "start_and_check";

  assert.ok(codes(candidate).includes("CONTROLLER_MUST_SKIP_WITHOUT_MODEL"));
});

test("native schedules distinguish surface, target support, and accounting", async () => {
  const candidate = structuredClone(await loadOrganization());
  const schedule = candidate.spec.schedules[0]!;
  schedule.executor = "provider_native";
  schedule.executionTarget = "generic-local";
  schedule.noWorkBehavior = "start_and_check";

  const missingSurfaceCodes = codes(candidate);
  assert.ok(missingSurfaceCodes.includes("NATIVE_SCHEDULE_SURFACE_REQUIRED"));
  assert.ok(
    missingSurfaceCodes.includes("NATIVE_SCHEDULE_DEGRADED_GUARD_REQUIRED"),
  );

  schedule.nativeSurface = "local";
  assert.ok(codes(candidate).includes("NATIVE_SCHEDULE_CAPABILITY_MISMATCH"));
});

test("host capability mismatches fail independently of model capabilities", async () => {
  const candidate = structuredClone(await loadOrganization());
  const manifests = structuredClone(runtimeManifests);
  manifests.managedRunners[0]!.capabilities =
    manifests.managedRunners[0]!.capabilities.filter(
      ({ name }) => name !== "host.delegate.subagent",
    );

  assert.ok(codes(candidate, manifests).includes("HOST_CAPABILITY_MISMATCH"));
});

test("model capability mismatches fail independently of host capabilities", async () => {
  const candidate = structuredClone(await loadOrganization());
  const manifests = structuredClone(runtimeManifests);
  manifests.modelEngines[0]!.capabilities =
    manifests.modelEngines[0]!.capabilities.filter(
      ({ name }) => name !== "model.tool_calling",
    );

  assert.ok(codes(candidate, manifests).includes("MODEL_CAPABILITY_MISMATCH"));
});

test("emulated capabilities require an explicit role opt-in", async () => {
  const candidate = structuredClone(await loadOrganization());
  candidate.spec.roles[0]!.execution.allowEmulation = false;

  assert.ok(
    codes(candidate).includes("EMULATED_CAPABILITY_REQUIRES_OPT_IN"),
  );

  candidate.spec.roles[0]!.execution.allowEmulation = true;
  assert.equal(
    codes(candidate).includes("EMULATED_CAPABILITY_REQUIRES_OPT_IN"),
    false,
  );
});

test("experimental peer teams require explicit opt-in", async () => {
  const candidate = structuredClone(await loadOrganization());
  const role = candidate.spec.roles[1]!;
  role.orchestration = {
    strategy: "peer_team",
    maxWorkers: 2,
    workspaceIsolation: "required",
    communication: "peer_messages",
    humanApprovalAuthority: "control_plane_only",
  };
  const manifests = structuredClone(runtimeManifests);
  for (const runner of manifests.managedRunners) {
    runner.capabilities.push({
      name: "host.delegate.peer_team",
      support: "native",
      stability: "experimental",
    });
  }

  assert.ok(
    codes(candidate, manifests).includes(
      "EXPERIMENTAL_CAPABILITY_REQUIRES_OPT_IN",
    ),
  );

  role.orchestration.allowExperimental = true;
  assert.equal(
    codes(candidate, manifests).includes(
      "EXPERIMENTAL_CAPABILITY_REQUIRES_OPT_IN",
    ),
    false,
  );
});

test("parallel writers require isolation or explicit ownership", async () => {
  const candidate = structuredClone(await loadOrganization());
  candidate.spec.roles[1]!.orchestration!.workspaceIsolation = "preferred";

  assert.ok(codes(candidate).includes("PARALLEL_WRITE_REQUIRES_ISOLATION"));
});

test("fallback cannot increase the permission ceiling", async () => {
  const candidate = structuredClone(await loadOrganization());
  const manifests = structuredClone(runtimeManifests);
  manifests.managedRunners[1]!.permissionCeiling = "external_side_effect";

  assert.ok(
    codes(candidate, manifests).includes("FALLBACK_PERMISSION_ESCALATION"),
  );
});

test("fallbacks must satisfy the same independent capability contract", async () => {
  const candidate = structuredClone(await loadOrganization());
  const manifests = structuredClone(runtimeManifests);
  manifests.modelEngines[1]!.capabilities =
    manifests.modelEngines[1]!.capabilities.filter(
      ({ name }) => name !== "model.tool_calling",
    );

  assert.ok(codes(candidate, manifests).includes("MODEL_CAPABILITY_MISMATCH"));
});

test("profile and discovered adapter mismatches are rejected", async () => {
  const candidate = structuredClone(await loadOrganization());
  const manifests = structuredClone(runtimeManifests);
  manifests.modelEngines[0]!.adapter = "different-adapter";

  assert.ok(codes(candidate, manifests).includes("RUNTIME_ADAPTER_MISMATCH"));
});

test("disabled targets cannot be assigned to a role", async () => {
  const candidate = structuredClone(await loadOrganization());
  candidate.spec.executionTargets[0]!.enabled = false;

  assert.ok(codes(candidate).includes("DISABLED_EXECUTION_TARGET"));
});

test("role concurrency cannot exceed the global budget", async () => {
  const candidate = structuredClone(await loadOrganization());
  candidate.spec.roles[1]!.concurrency = 4;

  assert.ok(codes(candidate).includes("ROLE_EXCEEDS_GLOBAL_CONCURRENCY"));
});
