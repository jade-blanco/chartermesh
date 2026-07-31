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
