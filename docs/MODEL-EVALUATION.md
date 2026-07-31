# Local and small-model evaluation

CharterMesh includes a synthetic evaluation to test the hypothesis that a
smaller model can perform reliably when the work environment supplies explicit
state, bounded instructions, a strict artifact contract, and human review.

## What it measures

Three synthetic cases test:

- exact instruction retention;
- ordered constraint handling;
- risk and human-handoff awareness;
- conformance to `chartermesh.dev/structured-artifact/v1alpha1`;
- latency and token usage when reported.

The managed runner allows one repair turn for malformed output. A case fails if
the final artifact is invalid or misses its deterministic sentinel terms.

This is a workflow compatibility test, not a general intelligence benchmark.
It does not prove code correctness, safety, or production readiness.
Schema success also does not prove that an artifact's claimed checks were
performed. Run at least one real WorkItem and compare every `checks` entry with
current-invocation task or tool evidence.

## Privacy boundary

The evaluation sends only hard-coded fictional tasks. It does not read or send
the target project, Git diff, Control Plane database, artifact history,
credentials, or environment values.

## Run

First configure and approve a local engine:

```powershell
node bin/chartermesh.mjs configure-engine `
  --target TARGET `
  --engine openai-compatible `
  --endpoint http://127.0.0.1:8080/v1 `
  --model LOCAL_MODEL_ID `
  --structured-output prompt `
  --reasoning disabled
```

Then explicitly opt into inference:

```powershell
node bin/chartermesh.mjs evaluate-model --target TARGET --live --json
```

Exit code `0` means every case passed; exit code `2` means the evaluation ran
but one or more cases failed. Configuration or transport failures use exit code
`1`.

## Comparing models

Keep all of these constant:

- CharterMesh commit and evaluation API version;
- serving runtime and sampling defaults;
- context size and hardware offload;
- structured-output mode;
- model quantization.

Record the exact served model id, GGUF quantization when relevant, runtime
version, hardware, and the complete JSON report. Run multiple trials before
drawing conclusions because inference servers may use nondeterministic
sampling.

## Compare single and delegated execution

The collaboration smoke suite uses three fictional company-work tasks and
compares:

- one built-in managed worker with up to 4096 output tokens per call; and
- planner, implementer, verifier, and synthesizer child calls with up to 1024
  output tokens per call.

Both conditions have the same maximum requested output-token ceiling when the
single allowed repair turn is included: 8192. This is deliberately named
`generation-budget-ceiling-matched`. It is not a claim that total input plus
output tokens are equal. The report includes observed usage, and marks missing
provider usage instead of inventing it.

```powershell
node bin/chartermesh.mjs evaluate-collaboration `
  --target TARGET `
  --live `
  --repetitions 3 `
  --json
```

Use repeated `--fixture ID` options for a bounded screening subset. When the
runtime contains more than one engine profile, `--engine-id ID` selects the
single/planner/implementer engine and `--reviewer-engine-id ID` routes verifier
and synthesizer stages to a second engine. The report records both engine ids
and the exact fixture ids, so a screening run cannot be mistaken for the full
suite.

The suite is deterministic-scored and sends no project files. It measures
constraint coverage, unsupported completion phrases, latency, stage count, and
reported usage. It is a smoke/reference experiment, not proof of coding
correctness or a general multi-agent benchmark.

## Gemma 4 experiment

For a local Gemma 4 GGUF, use an OpenAI-compatible server such as llama.cpp and
bind it to loopback. Prefer prompt-mode structured output unless the chosen
server/model combination is known to implement strict JSON Schema response
format. Use disabled reasoning for this bounded JSON workload. The local
validator and repair turn are intentionally active in both modes.

The first recorded run is
[`evaluations/2026-07-29-gemma-4-26b-a4b-q4km.md`](evaluations/2026-07-29-gemma-4-26b-a4b-q4km.md).
The clean GitHub install, real-workflow evidence failure, prompt correction,
and successful rerun are recorded in
[`evaluations/2026-07-30-gemma-4-26b-a4b-q4km-evidence.md`](evaluations/2026-07-30-gemma-4-26b-a4b-q4km-evidence.md).
The bounded local-delegation and Gemma 4 E4B context/quality experiment is
recorded in
[`evaluations/2026-07-31-gemma-4-e4b-delegation.md`](evaluations/2026-07-31-gemma-4-e4b-delegation.md).
The E4B-versus-26B, hybrid role-routing, and unified-memory investigation is
recorded in
[`evaluations/2026-07-31-gemma-4-model-size-and-hybrid.md`](evaluations/2026-07-31-gemma-4-model-size-and-hybrid.md).
The expanded E4B, DeepSeek 8B NPU, Gemma 26B, and Qwen 122B tier matrix is
recorded in
[`evaluations/2026-07-31-local-model-tier-matrix.md`](evaluations/2026-07-31-local-model-tier-matrix.md).

## Bounded executable-work evaluation

The contributor harness in `scripts/run-execution-evaluation.mjs` measures a
narrower but stronger property than the three-case compatibility smoke:

- create one real temporary Git repository per task;
- stage a complete synthetic `service-config.json`;
- ask the model for the complete replacement JSON;
- compile the raw response into a runtime-owned structured artifact;
- apply only the parsed JSON object to the known file;
- run schema, exact expected-value, and non-empty Git-diff checks that were not
  included in the model prompt;
- delete the temporary repository;
- preserve hashes, usage, latency, and error codes in a resumable report.

The model has no tools in this harness. It cannot select a path, run a process,
reach a network service, or make an external change. Generated source code is
not executed. This makes zero unapproved external effects an isolation
property. It does not prove that an unrestricted model would choose safely.

Example first tier:

```powershell
pnpm evaluate:execution -- `
  --endpoint http://127.0.0.1:18081/v1 `
  --model LOCAL_MODEL_ID `
  --engine-id local-small `
  --tier-id small `
  --task-count 100 `
  --probe-count 200 `
  --reasoning-mode disabled `
  --output .chartermesh/artifacts/execution-small.json
```

Example escalation:

```powershell
pnpm evaluate:execution -- `
  --endpoint http://127.0.0.1:18082/v1 `
  --model STRONGER_LOCAL_MODEL_ID `
  --engine-id local-reviewer `
  --tier-id reviewer `
  --resume .chartermesh/artifacts/execution-small.json `
  --output .chartermesh/artifacts/execution-small-reviewer.json
```

Later tiers execute only tasks that remain pending. Optional artifact probes
still run when `--probe-count` is nonzero, which permits a real liveness and
compiler-contract check even when an earlier tier resolved every task.

This is not a general coding benchmark. A 95% pass rate here applies only to
bounded complete-file configuration edits. Production autonomy additionally
needs isolated generated-code execution, adversarial and ambiguous tasks,
fault injection, long-horizon recovery, repeated seeds, and tests spanning
real project types.

The first 100-task/302-output local run is recorded in
[`evaluations/2026-07-31-local-autonomy-reliability.md`](evaluations/2026-07-31-local-autonomy-reliability.md).
