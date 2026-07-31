# Local model tier-matrix experiment

- Date: 2026-07-31
- Device: AMD Radeon 8060S, 128 GB unified memory
- Evaluation suite: `small-model-company-work-v1`
- Suite SHA-256:
  `21db6c1ee77b14321134092bb7d8833a1e474050246eef4b35caa690318f5e38`
- Scoring: deterministic concept coverage and forbidden-claim checks
- External model API cost: none

## Question

Does assigning a stronger local model to verifier and synthesizer roles make a
small-model organization reliable enough for company operations?

## Available local models

| Tier | Model | Runtime | Relevant serving mode |
|---|---|---|---|
| Small | Gemma 4 E4B Q4_K_M | llama.cpp Vulkan | reasoning disabled, 131K context |
| Small reasoning | DeepSeek-R1-Distill-Llama-8B | Lemonade Ryzen AI NPU | reasoning could not be disabled by the compatible request |
| Medium | Gemma 4 26B A4B UD-Q4_K_M | llama.cpp Vulkan | reasoning disabled, 32K context |
| Large escalation | Qwen 3.5 122B A10B UD-Q4_K_XL | Lemonade llama.cpp Vulkan | server-level `--reasoning off`, 16K context |

Qwen 3.5 was initially served with reasoning enabled. A 256-token probe placed
all output outside `message.content`, making the result unusable to the
structured-artifact adapter. Reloading llama.cpp with `--reasoning off`
produced the exact requested JSON in 0.89 seconds. Serving mode is therefore
part of the tested configuration, not incidental infrastructure.

## Matrix

Planner and implementer are the worker tier. Verifier and synthesizer are the
reviewer tier.

| Worker | Reviewer | Scope | Single mean/pass | Delegated mean/pass | Result |
|---|---|---|---:|---:|---|
| E4B | E4B | 3 fixtures x 3 | 0.6502, 1/9 | 0.8781, 2/9 | Better coverage, unreliable |
| E4B | Gemma 26B | 3 fixtures x 3 | 0.6173, 0/9 | 0.8654, 6/9 | Best practical resident hybrid |
| Gemma 26B | Gemma 26B | 3 fixtures x 3 | 0.8733, 1/9 | 0.7556, 6/9 | Two delegated format failures |
| DeepSeek 8B NPU | DeepSeek 8B NPU | hardest fixture x 1 | 0.5000, 0/1 | 0.6000, 0/1 | Too slow and incomplete |
| DeepSeek 8B NPU | Gemma 26B | hardest fixture x 1 | 0.5000, 0/1 | 1.0000, 1/1 | Reviewer recovered quality, but slow |
| Qwen 122B | Qwen 122B | 3 fixtures x 3 | about 0.8841, 3/9 | about 0.8778, 7/9 | Highest pass rate, one format failure |

The Qwen result combines one three-fixture run and a later two-repetition
six-fixture run under the same model, server flags, fixture suite, and budget.
Its delegated score is 7.9/9 = 0.8778 and its single score is approximately
7.9566/9 = 0.8841.

Evaluation ids:

- E4B:
  `collaboration-evaluation-f6265b50-6c04-403f-b60c-621526616f12`
- E4B worker, Gemma 26B reviewer:
  `collaboration-evaluation-872654fd-dc14-407e-8569-75f44f974614`
- Gemma 26B:
  `collaboration-evaluation-8222905e-1b84-4b6b-9a50-c0b16278868b`
- DeepSeek 8B hardest-fixture screen:
  `collaboration-evaluation-442524d7-53f9-4fbe-ac74-bdf593670643`
- DeepSeek 8B worker, Gemma 26B reviewer:
  `collaboration-evaluation-3b25ce65-747d-41d7-af5c-dbb498ca65e1`
- Qwen 122B first repetition:
  `collaboration-evaluation-6266c194-bfe5-4057-8a4e-e6450606bab5`
- Qwen 122B following two repetitions:
  `collaboration-evaluation-20582c6e-f942-449c-b5c6-69e39e73d01f`

## Latency and memory observations

- DeepSeek 8B NPU took about 278 seconds for one four-role delegated
  concurrency task and still failed exact coverage.
- Replacing only its verifier and synthesizer with Gemma 26B passed that task,
  but still took about 206 seconds.
- Qwen 122B delegated runs averaged roughly 98 seconds per task in the combined
  sample. Single runs averaged roughly 17 seconds.
- Loading Qwen 122B raised Windows commit charge to roughly 118.6 GB against a
  then-current 120.4 GB limit. It was stable for sequential evaluation after
  the page file grew, but left too little commit margin for another GPU model.
- E4B and Gemma 26B can remain resident together with prompt caches disabled.
  After restoring both servers, they used about 3.5 GB and 16.7 GB working set,
  respectively.

Qwen was therefore tested as a standalone escalation tier. A Qwen reviewer
cannot safely coexist with another GPU-resident worker on this machine under
the current process model. Supporting that combination requires a cold-switch
router that unloads the worker before loading the reviewer, preserves the
handoff durably, and accounts for model-load latency.

## What the result establishes

The evidence supports three claims:

1. A stronger verifier and synthesizer can materially recover constraints
   missed by a smaller worker.
2. Delegation improves exact completeness more consistently than mean score.
   Strong models sometimes become less reliable when four long structured
   outputs introduce truncation or malformed JSON opportunities.
3. The E4B plus Gemma 26B pairing is the best currently observed always-resident
   configuration. Qwen 122B is a useful high-risk escalation model, not a
   sensible always-on default.

It does not establish autonomous company-operation readiness.

## Readiness judgment

Current status: **assisted company workflow, not autonomous company operation**.

Suitable:

- drafting plans and organizational proposals;
- preparing implementation and review checklists;
- producing human-facing approval packets;
- bounded local tool work with exact approval gates;
- escalating failed or high-risk artifacts to a stronger reviewer.

Not yet supported by this evidence:

- unattended repository changes;
- autonomous release or financial decisions;
- claims that generated implementation compiles or passes hidden tests;
- continuous multi-day operation without human supervision;
- a 99% structured-output reliability target;
- safe hot coexistence of the 122B escalation model and another GPU model.

Before calling the system company-operation capable, the next suite should add:

- real temporary repositories and hidden executable tests;
- tool-call correctness and evidence validation;
- interruption, retry, cancellation, and stale-lease scenarios during model
  work;
- at least eight task families and five or more repetitions;
- per-tier latency and memory service-level objectives;
- a cold-switch escalation router;
- a release criterion such as at least 95% hidden-test success and at least
  99% valid structured artifacts, with no unapproved side effects.

## Harness changes prompted by the experiment

`evaluate-collaboration` now supports:

- repeated `--fixture ID` options for bounded screening;
- `--engine-id ID` for the single/planner/implementer engine;
- `--reviewer-engine-id ID` for verifier and synthesizer;
- exact engine and fixture provenance in the report;
- continued evaluation after an individual structured-artifact failure.

These are evaluation features. Normal delegated work does not yet read a
reviewer-engine route from runtime configuration, so the measured hybrid must
not be described as the default operating path until that configuration and
Control Plane provenance are implemented.

## Primary references

- [Google Gemma 4 model card](https://ai.google.dev/gemma/docs/core/model_card_4)
- [Qwen 3.5 122B A10B model card](https://huggingface.co/Qwen/Qwen3.5-122B-A10B)
- [DeepSeek-R1 and distilled model documentation](https://huggingface.co/deepseek-ai/DeepSeek-R1)
- [llama.cpp reasoning-mode discussion](https://github.com/ggml-org/llama.cpp/discussions/23351)
- [llama.cpp Qwen thinking-mode issue](https://github.com/ggml-org/llama.cpp/issues/20182)
