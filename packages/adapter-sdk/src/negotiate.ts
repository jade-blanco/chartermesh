import type {
  AgentHostManifest,
  CapabilityDescriptor,
  ManagedRunnerManifest,
  ModelEngineManifest,
  RuntimeBindingResolution,
  RuntimeRequirement,
} from "./types.ts";

function resolveCapabilities(
  requiredNames: string[],
  available: CapabilityDescriptor[],
  requirement: RuntimeRequirement,
  prefix: "MODEL" | "HOST",
): { issues: string[]; degraded: boolean } {
  const issues: string[] = [];
  let degraded = false;

  for (const name of requiredNames) {
    const capability = available.find((candidate) => candidate.name === name);
    if (!capability || capability.support === "unsupported") {
      issues.push(`${prefix}_CAPABILITY_MISMATCH:${name}`);
      continue;
    }
    if (
      capability.support === "emulated" &&
      !requirement.allowEmulation
    ) {
      issues.push(`${prefix}_EMULATION_REQUIRES_OPT_IN:${name}`);
      continue;
    }
    if (capability.support === "manual_step_required") {
      issues.push(`${prefix}_CAPABILITY_MANUAL_ONLY:${name}`);
      continue;
    }
    if (
      capability.stability === "experimental" &&
      !requirement.allowExperimental
    ) {
      issues.push(`${prefix}_EXPERIMENTAL_REQUIRES_OPT_IN:${name}`);
      continue;
    }
    if (
      capability.support === "emulated" ||
      capability.stability !== "stable"
    ) {
      degraded = true;
    }
  }

  return { issues, degraded };
}

export function negotiateRuntimeBinding(
  engine: ModelEngineManifest | undefined,
  host: AgentHostManifest | ManagedRunnerManifest,
  requirement: RuntimeRequirement,
): RuntimeBindingResolution {
  const issueCodes: string[] = [];

  if (host.engineBinding === "injectable" && !engine) {
    issueCodes.push("INJECTABLE_HOST_REQUIRES_MODEL_ENGINE");
  }
  if (host.engineBinding === "host_managed" && engine) {
    issueCodes.push("HOST_MANAGED_ENGINE_REJECTS_INJECTION");
  }

  const model = resolveCapabilities(
    requirement.modelCapabilities,
    engine?.capabilities ??
      (host.kind === "agent_host" ? host.modelCapabilities ?? [] : []),
    requirement,
    "MODEL",
  );
  const hostResult = resolveCapabilities(
    requirement.hostCapabilities,
    host.capabilities,
    requirement,
    "HOST",
  );
  issueCodes.push(...model.issues, ...hostResult.issues);

  const ok = issueCodes.length === 0;
  return {
    ok,
    status: !ok
      ? "unsupported"
      : model.degraded || hostResult.degraded
        ? "degraded"
        : "native",
    issueCodes,
    capabilitySnapshot: {
      model:
        engine?.capabilities ??
        (host.kind === "agent_host" ? host.modelCapabilities ?? [] : []),
      host: host.capabilities,
    },
  };
}
