import { readFile } from "node:fs/promises";
import type { RuntimeManifestSet } from "../../adapter-sdk/src/types.ts";
import type { OrganizationSpec } from "../src/types.ts";

export const runtimeManifests: RuntimeManifestSet = {
  modelEngines: [
    {
      kind: "model_engine",
      profileId: "primary-llm",
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
        {
          name: "model.tool_calling",
          support: "native",
          stability: "stable",
        },
      ],
    },
    {
      kind: "model_engine",
      profileId: "simulated-llm",
      adapter: "fake-model-engine",
      contractVersion: "v1alpha1",
      capabilities: [
        {
          name: "model.text.generate",
          support: "native",
          stability: "stable",
        },
        {
          name: "model.structured_output",
          support: "native",
          stability: "stable",
        },
        {
          name: "model.tool_calling",
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
      profileId: "primary-runner",
      adapter: "builtin-managed-runner",
      contractVersion: "v1alpha1",
      permissionCeiling: "workspace_write",
      engineBinding: "injectable",
      capabilities: [
        {
          name: "host.session.resume",
          support: "native",
          stability: "stable",
          permissionBehavior: "callback",
          costVisibility: "measured",
        },
        {
          name: "host.delegate.subagent",
          support: "native",
          stability: "stable",
          permissionBehavior: "callback",
          costVisibility: "measured",
        },
        {
          name: "host.workspace.isolated",
          support: "native",
          stability: "stable",
          workspaceIsolation: "native",
          costVisibility: "unknown",
        },
        {
          name: "runner.tool_loop",
          support: "native",
          stability: "stable",
        },
      ],
    },
    {
      kind: "managed_runner",
      profileId: "simulated-runner",
      adapter: "fake-managed-runner",
      contractVersion: "v1alpha1",
      permissionCeiling: "read_only",
      engineBinding: "injectable",
      capabilities: [
        {
          name: "host.session.resume",
          support: "native",
          stability: "stable",
        },
        {
          name: "host.delegate.subagent",
          support: "native",
          stability: "stable",
        },
        {
          name: "host.workspace.isolated",
          support: "native",
          stability: "stable",
          workspaceIsolation: "native",
        },
        {
          name: "runner.tool_loop",
          support: "native",
          stability: "stable",
        },
      ],
    },
  ],
};

export async function loadOrganization(): Promise<OrganizationSpec> {
  const url = new URL(
    "../../../examples/balanced-software-team/organization.json",
    import.meta.url,
  );
  return JSON.parse(await readFile(url, "utf8")) as OrganizationSpec;
}
