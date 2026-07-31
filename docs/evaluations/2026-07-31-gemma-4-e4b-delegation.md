# Gemma 4 E4B bounded-delegation experiment

- Date: 2026-07-31
- CharterMesh implementation commit: `c2d9458`
- Suite: `small-model-company-work-v1`
- Suite SHA-256:
  `21db6c1ee77b14321134092bb7d8833a1e474050246eef4b35caa690318f5e38`
- Evaluation API:
  `chartermesh.dev/collaboration-evaluation/v1alpha1`

## Question

Can a small local model produce more complete company-style plans and review
artifacts when CharterMesh gives it a bounded planner → implementer → verifier
→ synthesizer structure? Does the local runtime really prevent contexts above
64K?

## Runtime

- Model: Gemma 4 E4B instruction-tuned GGUF
- Quantization: Q4_K_M
- GGUF bytes: 4,977,171,584
- GGUF SHA-256:
  `85a896a047553e842f25297ee5b031d64ff30147d9c4af17b1e4b394cd1fab87`
- Server: llama.cpp `b9585` (`d73cd0767`)
- Backend: Vulkan
- GPU: AMD Radeon 8060S
- Loaded context: 131,072
- Model training context reported by `/v1/models`: 131,072
- API: loopback OpenAI-compatible Chat Completions
- Structured output: prompt contract plus local validation
- Thinking: disabled
- Parallel slots: 1

No paid model API, cloud deployment, project file, credential, or external
search was used.

## Lemonade context hypothesis

The installed Lemonade configuration had an explicit global
`ctx_size` of 65,536 and `global_timeout` of 300 seconds. Lemonade's documented
API permits per-load context overrides, and its benchmark suite includes 32K,
64K, and 128K long-context scenarios. Therefore 64K was a local configuration,
not a fixed Lemonade or Gemma limit.

The built-in model pull attempted a roughly 5.6 GB three-file download. The
4.98 GB text GGUF reached 100%, but the client connection failed before the
remaining files were finalized. The failure repeated at approximately the
large-file completion boundary. The completed text GGUF and Lemonade's bundled
llama.cpp Vulkan backend were reused directly; Ollama was not required.

## Actual context test

Direct `llama-server` loaded one slot with `n_ctx = 131072`. It correctly
rejected a 210,024-token request as larger than that limit. A second synthetic
request completed successfully:

| Field | Result |
|---|---:|
| HTTP status | 200 |
| Prompt tokens | 65,724 |
| Completion tokens | 2 |
| Response | `OK` |
| Elapsed | 160.630 seconds |
| Cached prompt tokens | 53,259 |

This proves that the server can process a request above 65,536 tokens. The
latency is a warm/cache-assisted result, not a cold 65K throughput benchmark.
The preceding cold attempt processed 53,259 tokens before the five-minute HTTP
client timeout. Long context is therefore compatible but operationally slow on
this configuration.

## Collaboration method

Each paired trial used the same fictional task and model:

- `single`: one managed worker, maximum 4,096 output tokens per call;
- `delegated`: four fresh role contexts, maximum 1,024 output tokens per call.

Each call permits one structured-output repair. Both conditions therefore
share the same maximum requested output-token ceiling of 8,192. This is
`generation-budget-ceiling-matched`, not total-token matched. Inputs are much
larger in the delegated condition because handoffs are explicit.

The three fixtures cover:

1. initial organization and MVP blueprint for fictional RepairRelay;
2. concurrent SQLite claim hardening;
3. a human-readable release gate with missing evidence.

Scoring is deterministic concept coverage minus forbidden completion claims.
It does not use an LLM judge.

## One-run diagnostic

The first diagnostic run completed in 107.3 seconds:

| Condition | Mean score | Exact pass rate |
|---|---:|---:|
| Single | 0.7376 | 0/3 |
| Delegated | 0.8889 | 2/3 |
| Delta | +0.1513 | +2 cases |

Delegation recovered every named constraint in the organization bootstrap and
concurrency design cases. Both conditions still omitted release-gate concepts,
showing that repeated role prompting does not guarantee completeness.

## Three-repetition result

Evaluation id:
`collaboration-evaluation-f6265b50-6c04-403f-b60c-621526616f12`

Elapsed wall time: 258.4 seconds for nine paired trials.

| Metric | Single | Delegated | Difference |
|---|---:|---:|---:|
| Mean deterministic score | 0.6502 | 0.8781 | +0.2278 |
| Exact passes | 1/9 | 2/9 | +1 |
| Exact pass rate | 11.11% | 22.22% | +11.11 pp |
| Observed input + output tokens | 7,942 | 48,062 | +40,120 |
| Token ratio | 1.00× | 6.05× | +5.05× |

All trials returned locally valid structured artifacts and no forbidden
completion phrase was reported in the captured summary. Provider token counts
were present, but cost remained unknown because this was a local model without
user-supplied electricity or token pricing.

## Judgment

The experiment supports a narrow conclusion:

> Bounded role decomposition helped Gemma 4 E4B retain constraints and improved
> deterministic planning/review scores, but it did not make this configuration
> reliable enough for autonomous company-level implementation.

Recommended use today:

- organization drafts;
- implementation plans;
- risk and acceptance-criteria checklists;
- first-pass human review artifacts;
- bounded tool work where every write and final artifact remains
  human-approved.

Not supported by this result:

- unattended production changes;
- autonomous release approval;
- peer teams or nested delegation;
- claims of code correctness;
- replacing a stronger model for difficult implementation;
- cost or latency efficiency.

The 6.05× observed-token overhead is material. A practical policy should use
single execution by default and invoke delegation for high-risk, failed, or
constraint-dense work rather than every WorkItem.

## Implementation evidence

The implementation under test adds:

- provider-neutral, depth-1 sequential delegation;
- planner, implementer, verifier, and synthesizer child Attempts;
- durable pre-call model invocations and child usage;
- child limits, no nested delegation, and parent-only handoffs;
- cancellation recorded as `canceled` rather than `failed`;
- lease recovery for all unfinished child calls in a Run;
- `run --delegated`;
- `evaluate-collaboration`;
- a synthetic long-context compatibility script;
- offline fake-engine tests and CLI E2E.

`pnpm verify` passed 106 tests, repository boundary checks, and the clean
consumer package-install test.

## Limitations and next experiment

- Three public synthetic fixtures and three repetitions are exploratory.
- Exact-term coverage rewards mention, not implementation depth.
- Sampling controls were not pinned by the current neutral engine contract.
- The comparison did not edit a virtual repository or score hidden code tests.
- Child roles are Attempts inside one foreground process. Independent
  crash-resumable child WorkItems and join barriers remain future work.
- Native Codex, Claude, or other AgentHost children are not implemented.

The next reference should use a virtual filesystem, hidden deterministic
assertions, one writer, at least eight fixtures and five repetitions, plus a
larger-model baseline. It should keep human tool approval intact for any
separate real-workspace demonstration.

## Primary references

- [Google Gemma 4 model card](https://ai.google.dev/gemma/docs/core/model_card_4)
- [Lemonade server configuration](https://lemonade-server.ai/docs/guide/configuration/)
- [Lemonade llama.cpp backend options](https://lemonade-server.ai/docs/guide/configuration/llamacpp/)
- [Lemonade CLI and long-context benchmark options](https://lemonade-server.ai/docs/guide/cli/)
- [llama.cpp OpenAI-compatible server options](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md)
