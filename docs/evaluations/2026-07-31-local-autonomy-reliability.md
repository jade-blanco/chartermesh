# Local autonomy reliability experiment

- Date: 2026-07-31
- Scope: bounded synthetic configuration edits in real temporary Git
  repositories
- Hardware: AMD Radeon 8060S integrated GPU with 128 GB shared system memory
- Network/provider cost: none; all inference ran on loopback
- Harness: `chartermesh.dev/execution-evaluation/v1alpha1`
- Suite: `bounded-config-repository-v1`
- Seed: `20260731`

## Question

Can a small local Gemma model exceed the proposed minimums of 95% hidden
executable-test success, 99% structured-output success, and zero unapproved
external side effects when CharterMesh supplies a narrow contract, runtime
artifact compilation, and ordered escalation?

## Setup

The valid run used:

| Tier | Model | Quantization | Context | Role in this run |
|---|---|---:|---:|---|
| 1 | Gemma 4 E4B | Q4_K_M | 131,072 | 100 repository tasks + 200 probes |
| 2 | Gemma 4 26B A4B | UD-Q4_K_M | 32,768 | post-success transition probe |
| 3 | Qwen 3.5 122B A10B | UD-Q4_K_XL | 16,384 | cold-load transition probe |

The Gemma servers used llama.cpp Vulkan build `9585` (`d73cd0767`), one
parallel slot, Flash Attention, and prompt-cache RAM disabled. Qwen was loaded
alone through Lemonade with reasoning disabled and cache RAM disabled. E4B and
26B were stopped before Qwen load and restored sequentially afterward.

Each of 100 deterministic tasks:

1. created a fresh temporary Git repository;
2. wrote and staged a complete synthetic service configuration;
3. asked E4B to return one complete replacement JSON object;
4. compiled the raw model text into a canonical `StructuredArtifact`;
5. applied only the first parsed JSON object to the known file;
6. ran model-hidden schema, exact-value, and Git-diff tests;
7. removed the temporary repository.

The task generator covers retry policy, approval rules, limits, feature flags,
workflow ordering, ownership/revision, environment/region, and compound edits.
It contains a regression test proving every generated task changes the
repository.

The model received no tools and no filesystem path. The harness did not run
model-generated code.

## Valid result

| Metric | Result | Proposed minimum |
|---|---:|---:|
| Hidden executable tests | 100/100 (100%) | 95% |
| Runtime-compiled structured outputs | 302/302 (100%) | 99% |
| Sentinel retention probes | 202/202 (100%) | diagnostic |
| Unapproved external side effects | 0 | 0 |
| Tasks requiring 26B escalation | 0 | n/a |
| Tasks requiring Qwen escalation | 0 | n/a |

All 100 tasks passed at E4B. Consequently, the later models had no pending
task to recover. Each later tier executed a real probe through the same
resumable report, so endpoint transition and Artifact Compiler compatibility
were exercised, but this run provides no comparative 26B or Qwen task-accuracy
measurement and no evidence that escalation improved the score.

The final local report SHA-256 was
`ED42895518C2F0640AACCC0407CFE942BF1EBCBF5EDB571E2CF004E43AF2CB57`.
The raw report intentionally remains in ignored
`.chartermesh/artifacts/evaluations/` because it is machine evidence rather
than a shipped runtime asset. A compact machine-readable result is checked in
as
[`data/2026-07-31-local-autonomy-summary.json`](data/2026-07-31-local-autonomy-summary.json).

## Performance

E4B repository task latency:

| Statistic | Milliseconds |
|---|---:|
| Mean | 4,475 |
| p50 | 3,770 |
| p95 | 5,607 |
| p99 | 5,681 |
| Maximum | 5,759 |

E4B artifact-probe latency:

| Statistic | Milliseconds |
|---|---:|
| Mean | 452 |
| p50 | 446 |
| p95 | 492 |
| p99 | 566 |
| Maximum | 628 |

The 100 task calls reported 35,085 input and 19,541 output tokens. The 200 E4B
probes reported 7,800 input and 3,633 output tokens. Provider cost remained
unknown in the adapter record because local models have no configured price;
no paid API was used.

## Invalidated pilot

An initial pilot was stopped and excluded after the Git-diff check revealed a
suite-generation defect: one feature task could request values already equal
to the initial file. The generator was corrected so that every task has a
non-equal expected configuration, and an offline regression test now enforces
that invariant. None of the pilot outputs contribute to the reported rates.

## Interpretation

The three numerical minimums were met for this exact bounded suite. This is
useful evidence that a small local model can be dependable when:

- state is compact and explicit;
- the requested mutation is exact;
- the output grammar is narrow;
- the runtime owns artifact serialization;
- a deterministic hidden test decides success;
- larger models are available only for unresolved work.

It is not evidence that E4B can autonomously operate a company. The run did
not test arbitrary source-code changes, ambiguous product planning,
multi-repository work, web research, secrets, external systems, adversarial
instructions, long-horizon recovery, or human-quality judgment. Zero external
effects was enforced by isolation, not inferred from model behavior.

The next defensible autonomy gate is a separately sandboxed generated-code
suite with repeated hidden tests, fault injection, and task-family holdouts.
Until that exists, CharterMesh should describe this result as **bounded
configuration-operation reliability**, not general autonomous operation.
