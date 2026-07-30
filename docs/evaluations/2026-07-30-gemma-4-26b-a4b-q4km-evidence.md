# Gemma 4 clean-install and evidence-discipline evaluation

- Date: 2026-07-30
- GitHub install baseline: `0.0.6-alpha.1`
- Evidence fix under test: `0.0.7-alpha.1` working tree
- Model adapter: `openai-compatible`, loopback only
- Runtime: Lemonade llama.cpp Vulkan server build 9585 (`d73cd0767`)
- Model: `gemma-4-26b-a4b-it`, Unsloth UD-Q4_K_M GGUF
- Model file: 16,947,539,744 bytes
- Context: 8,192 tokens; reasoning budget 0
- Hardware: AMD Ryzen AI MAX+ PRO 395, Radeon 8060S, 64 GB system memory
- Paid API or provider account: none

## Clean GitHub application

The CLI was executed through:

```text
npx --yes github:jade-blanco/chartermesh
```

against a clean temporary target. The user-approved bootstrap plan hash was:

```text
95c8ee0f92985fa3f0608cb717a646c8bc5f5d247f6596732ff2074e64370619
```

The exact plan applied successfully and `doctor --json` reported the Control
Plane and runtime ready.

## Baseline synthetic compatibility

Evaluation `evaluation-ac18decf-d534-48d8-abc2-d3421af739b2` passed 3/3:

| Case | Result | Latency | Input | Output |
|---|---:|---:|---:|---:|
| instruction retention | pass | 3,494 ms | 248 | 119 |
| ordered reasoning | pass | 5,319 ms | 245 | 210 |
| risk awareness | pass | 4,020 ms | 256 | 154 |

No project files were sent by the evaluation.

## Real workflow finding

The installed version completed:

```text
requested -> ready -> in_progress -> review_pending
```

and stored an immutable structured artifact. However, with tool calling
disabled, the first artifact claimed that dependency manifests, environment
configuration, and endpoints had been inspected. No tool evidence supported
those checks.

This demonstrated that schema compliance and state-machine correctness do not
prove artifact evidence quality.

## Evidence-discipline correction

The ManagedRunner now tells every engine:

- list only checks performed in the current invocation;
- require direct task-packet or successful tool evidence;
- use an empty `checks` array when no check ran;
- move unperformed verification to future-tense `nextActions`;
- lower confidence and list missing evidence in `risks`.

The same local model and WorkItem were run again. The corrected artifact:

- returned `checks: []`;
- explicitly stated that manifests, connectivity, and environment variables
  were not inspected;
- moved static analysis, lockfile inspection, and isolated egress testing to
  `nextActions`;
- set confidence to `low`;
- reached `review_pending` with immutable artifact SHA-256
  `30247e5b4468a6b9b2c5182edb2cc29cb888573bf602e0686125adb3f5e4b46e`.

## Post-correction synthetic compatibility

Evaluation `evaluation-f833b502-2720-4785-9b25-a021dc84f065` passed 3/3:

| Case | Result | Latency | Input | Output |
|---|---:|---:|---:|---:|
| instruction retention | pass | 3,508 ms | 372 | 131 |
| ordered reasoning | pass | 4,860 ms | 369 | 188 |
| risk awareness | pass | 4,036 ms | 380 | 140 |

The larger prompt added explicit evidence rules but retained all required
sentinels and structured output.

## Interpretation

This supports a narrow claim: a local 4B-active-parameter MoE model can follow
the CharterMesh structured lifecycle and improve evidence honesty when the
runtime makes that boundary explicit. It does not prove the factual quality of
future code changes, tool-call reliability, or unattended safety. Human
artifact review and tool authorization remain mandatory.
