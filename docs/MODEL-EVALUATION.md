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

## Sealed code-maintenance pilot

The code-maintenance pilot compares functional implementation, not keyword
coverage. It uses six fictional dependency-free Node.js tasks across a work
order ledger, equipment desk, and settlement pipeline. Each model receives
the same repository state, ticket, and public examples. Hidden cases, oracle
implementations, mutations, and hidden results are withheld from every model
call.

The fixed comparison is:

| Condition | Calls per task | Requested output ceiling |
|---|---:|---:|
| Gemma 4 E4B single | 1 x 6,144 | 6,144 |
| Gemma 4 26B A4B single | 1 x 6,144 | 6,144 |
| Qwen 3.5 122B A10B single | 1 x 6,144 | 6,144 |
| E4B draft, 26B review, Qwen final | 3 x 2,048 | 6,144 |

There is one attempt per stage and no repair turn. The output-token ceiling is
matched, but the tiered route necessarily consumes more input tokens and model
invocation latency. The report records provider-reported token usage and
inference-call latency. Cold model loading is performed and timed outside this
pilot report, so it must be reported separately when comparing operational
latency. Equal requested output ceilings do not imply equal compute, input
tokens, tokenizer behavior, or final-stage capacity. Any tiered improvement is
therefore not attributable to model diversity without a same-model,
three-stage control condition.

Generation is resumable and stores complete candidates only under the ignored
`.chartermesh/artifacts/` directory. Run the stages while the corresponding
loopback engine is loaded. The engine slot is bound to its model, quantization,
context, server build, structured-output mode, reasoning mode, sampling
settings, and required model-artifact hash before the first call:

Publishable pilot generation must run from a source checkout at a clean Git
commit. Before the state is created or read, the command records the
CharterMesh package version, commit and dirty status, harness Node version,
selected runtime-executable SHA-256, OS version/build, and a canonical
SHA-256 manifest of every sandbox guest script. A missing commit or any dirty
state stops the command before inference. Every later generation stage
re-collects the same provenance and refuses to continue if it differs.

Use `pnpm evaluate:code:generate --` from that clean source checkout. The
installed `chartermesh-evaluate-code-generate` binary has no source-checkout
Git attestation and therefore cannot produce this publishable pilot. Installed
package evaluation remains non-publishable until a future package-artifact
signature or equivalent release provenance is added.

```powershell
pnpm evaluate:code:generate -- `
  --state .chartermesh/artifacts/code-pilot-state.json `
  --condition e4b-single `
  --stage final `
  --engine-slot e4b `
  --engine-id local-e4b `
  --endpoint http://127.0.0.1:18081/v1 `
  --model YOUR_E4B_MODEL_ID `
  --quantization Q4_K_M `
  --context-tokens 16384 `
  --server-build llama.cpp-b9585 `
  --model-artifact-sha256 SHA256_OF_THE_GGUF `
  --model-artifact-hash-kind file `
  --reasoning-mode disabled `
  --temperature 0 `
  --sampling-seed 20260731
```

The tiered stage order is `draft` with slot `e4b`, `review` with slot
`gemma26b`, then `final` with slot `qwen`. The other single condition ids are
`gemma26b-single` and `qwen-single`. Each command takes an exclusive state
lock. It records an `invocation_running` attempt before inference; if the
process dies during that call, resumption leaves the attempt indeterminate
instead of silently charging and retrying it. Only a complete matrix can be
atomically frozen for hidden evaluation.

All three slots must provide an artifact hash and use the same adapter,
context-token limit, structured-output mode, reasoning mode, temperature, and
sampling seed. Model timeout and maximum response bytes must also match. Freeze
fails if any of those comparison controls differ. Model id, quantization,
artifact hash, endpoint, and server build remain part of the per-engine
fingerprint and may differ. If the serving stacks differ, the result is a
comparison of the recorded configuration bundles rather than a claim about
model weights alone.

For a split GGUF, hash every shard in lexical filename order, serialize the
lowercase hashes as a compact JSON array, hash that UTF-8 JSON with SHA-256,
and use `--model-artifact-hash-kind canonical-shard-manifest`. This preserves
the distinction between a file digest and a deterministic multi-shard
fingerprint.

Generated code is never executed by the generation command. Evaluation
requires a live VM canary:

```powershell
pnpm evaluate:code:run -- `
  --state .chartermesh/artifacts/code-pilot-state.json `
  --output .chartermesh/artifacts/code-pilot-report.json
```

An installed package exposes a `chartermesh-evaluate-code-run` binary, but its
result is not publishable under this pilot contract without the future package
artifact attestation described above.

On Windows, install the Windows Sandbox optional feature from an elevated
PowerShell session and restart if requested:

```powershell
Enable-WindowsOptionalFeature `
  -FeatureName "Containers-DisposableClientVM" `
  -All `
  -Online `
  -NoRestart
```

Restart Windows manually if the command reports that a restart is required.

The evaluator does not silently use host Node, WSL, or a simulated backend if
Windows Sandbox or any canary is unavailable. Its custom configuration
disables networking, vGPU, clipboard, audio, video, and printer redirection,
enables Protected Client, maps input and a freshly staged exact Node executable
read-only, and maps only a disposable output directory writable. Each
candidate is executed in its own VM session. ADR 0018 records the complete
boundary. The exact runtime and guest scripts staged for each session are
rehashed against the provenance frozen before generation. Candidate results
are HMAC-framed by a separate secret-holding supervisor; that framing is not
treated as same-user OS isolation.

Before model candidates run, the evaluator checks all six oracle solutions,
the declared baseline defects, and 18 seeded erroneous mutations. A condition
passes a task only when its final response is strict JSON and every public and
hidden case passes with no sandbox policy violation. Intermediate tier
results are diagnostic only and are computed after all generation has ended,
so they cannot influence the later reviewer.

The suite source is intentionally published in this repository. Its hidden
cases are withheld from model inference during an experiment, but they are not
a secret certification set. Public reports bind each stage to request,
candidate, raw-output, engine-fingerprint, and result hashes plus finish
reason, usage, and latency. Model response rate and strict structured-output
rate use all durable invocation attempts as their denominator, so transport
failures cannot disappear from the reliability metric. Claims beyond this
development comparison require a separately governed private holdout.

OpenAI-compatible response `model` and `system_fingerprint` values are
preserved when a server supplies them. They are provider-reported evidence,
not a substitute for the required local artifact digest.

The JSON report labels itself as a public six-task, one-trial development
pilot with no statistical inference. The tiered condition is serial review
routing with canonical interstage normalization; it does not exercise Control
Plane child-agent creation, join, cancellation, or permission inheritance.
Usage is provider-reported or unknown, the output ceiling is a requested
limit rather than local tokenization proof, and latency is client-observed
generation latency excluding cold model load.
