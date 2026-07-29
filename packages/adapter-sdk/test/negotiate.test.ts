import assert from "node:assert/strict";
import test from "node:test";
import { negotiateRuntimeBinding } from "../src/index.ts";
import type {
  AgentHostManifest,
  ManagedRunnerManifest,
  ModelEngineManifest,
  RuntimeRequirement,
} from "../src/types.ts";

const engine: ModelEngineManifest = {
  kind: "model_engine",
  profileId: "any-llm",
  adapter: "generic-model-api",
  contractVersion: "v1alpha1",
  capabilities: [
    {
      name: "model.text.generate",
      support: "native",
      stability: "stable",
    },
    {
      name: "model.structured_output",
      support: "emulated",
      stability: "stable",
    },
  ],
};

const runner: ManagedRunnerManifest = {
  kind: "managed_runner",
  profileId: "local-runner",
  adapter: "builtin-managed-runner",
  contractVersion: "v1alpha1",
  permissionCeiling: "workspace_write",
  engineBinding: "injectable",
  capabilities: [
    {
      name: "runner.tool_loop",
      support: "native",
      stability: "stable",
    },
    {
      name: "host.approval_pause_resume",
      support: "native",
      stability: "stable",
    },
  ],
};

const requirements: RuntimeRequirement = {
  modelCapabilities: ["model.text.generate"],
  hostCapabilities: ["runner.tool_loop"],
  allowEmulation: false,
  allowExperimental: false,
};

test("an arbitrary model engine can bind to the managed runner", () => {
  const result = negotiateRuntimeBinding(engine, runner, requirements);
  assert.equal(result.ok, true);
  assert.equal(result.status, "native");
});

test("emulated model features require opt-in and become degraded", () => {
  const required = {
    ...requirements,
    modelCapabilities: ["model.structured_output"],
  };
  const rejected = negotiateRuntimeBinding(engine, runner, required);
  assert.ok(
    rejected.issueCodes.includes(
      "MODEL_EMULATION_REQUIRES_OPT_IN:model.structured_output",
    ),
  );

  const allowed = negotiateRuntimeBinding(engine, runner, {
    ...required,
    allowEmulation: true,
  });
  assert.equal(allowed.ok, true);
  assert.equal(allowed.status, "degraded");
});

test("a host-managed agent runtime rejects injected engines", () => {
  const externalHost: AgentHostManifest = {
    kind: "agent_host",
    profileId: "external-host",
    adapter: "external-agent-host",
    contractVersion: "v1alpha1",
    permissionCeiling: "workspace_write",
    engineBinding: "host_managed",
    capabilities: [
      {
        name: "host.session.start",
        support: "native",
        stability: "stable",
      },
    ],
  };
  const result = negotiateRuntimeBinding(engine, externalHost, {
    ...requirements,
    hostCapabilities: ["host.session.start"],
  });

  assert.ok(
    result.issueCodes.includes("HOST_MANAGED_ENGINE_REJECTS_INJECTION"),
  );
});

test("missing host capabilities cannot be satisfied by model capabilities", () => {
  const result = negotiateRuntimeBinding(engine, runner, {
    ...requirements,
    hostCapabilities: ["host.peer_team"],
  });

  assert.ok(
    result.issueCodes.includes("HOST_CAPABILITY_MISMATCH:host.peer_team"),
  );
});
