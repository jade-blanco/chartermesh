# ADR 0017: Runtime-owned artifacts and bounded execution evaluation

- Status: accepted
- Date: 2026-07-31

## Context

The built-in ManagedRunner originally asked every model to produce the complete
`StructuredArtifact` JSON envelope. A malformed envelope could be repaired
once, but output reliability still depended on the model understanding both
the work and CharterMesh's serialization contract. That burden is especially
costly for small local models.

The existing synthetic model evaluation checked instruction retention and
artifact shape, but it did not apply results to a real repository or run tests
the model could not see. It therefore could not support a claim about
executable work success.

Executing arbitrary model-generated source code would create a new untrusted
code-execution boundary. Node's permission model is defense in depth, not a
security boundary for hostile code, so it is not sufficient for that purpose.

## Decision

Add an experimental `runtime_compiled` artifact mode to the built-in
ManagedRunner. In this mode:

- the model produces a bounded human-readable deliverable;
- the runtime, not the model, creates the versioned artifact envelope;
- size limits, required fields, confidence, and canonical JSON are enforced
  deterministically;
- successful Tool Runtime evidence may populate checks;
- an empty model response becomes a valid low-confidence artifact with an
  explicit risk instead of a fabricated success.

The existing `model_json` mode remains the default for compatibility. The
capability is advertised as `runner.artifact_compiler`, native and
experimental.

Add a separate opt-in execution evaluation:

```text
synthetic request
  -> model complete replacement JSON
  -> Artifact Compiler measurement
  -> harness-owned temporary Git repository
  -> schema validation
  -> hidden exact-result and Git-diff tests
  -> pass or pending escalation
```

The evaluator generates deterministic bounded configuration changes. It
initializes and stages each repository itself, applies only a parsed JSON
object to one known file, and removes the temporary root afterward. The model
receives no tools and no path, network, process, credential, or external-effect
capability. Model-generated code is never executed.

Reports are resumable. A subsequent model tier receives only tasks still
pending from earlier tiers. Reports preserve engine and tier identity,
per-attempt latency and usage, output hashes, compiler status, hidden-test
error codes, and aggregate rates without storing raw model content.

Structured-output success, sentinel retention, executable-task success, and
unapproved external effects are separate metrics. A valid artifact is not
evidence that its work is correct.

## Consequences

- Small models no longer need to own final artifact serialization when the
  operator selects runtime compilation.
- A real file/repository boundary and model-hidden tests can be measured
  without introducing arbitrary generated-code execution.
- Local E4B-to-larger-model escalation can resume from one auditable report.
- The harness is a bounded configuration benchmark, not proof of autonomous
  coding, long-horizon planning, production security, or company operation.
- A future generated-code benchmark requires a separately designed OS or VM
  sandbox, resource controls, network denial, and artifact extraction policy.
