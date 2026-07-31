# Gemma 4 model-size and hybrid-routing experiment

- Date: 2026-07-31
- Suite: `small-model-company-work-v1`
- Suite SHA-256:
  `21db6c1ee77b14321134092bb7d8833a1e474050246eef4b35caa690318f5e38`
- Repetitions: three per fixture, three fixtures
- Backend: llama.cpp `b9585` (`d73cd0767`), Vulkan, one parallel slot
- Device: AMD Radeon 8060S with 128 GB unified system memory

## Questions

1. Is E4B's remaining failure rate mainly a context-server limitation or a
   model-capability limitation?
2. Does moving every role to Gemma 4 26B A4B improve the result?
3. Can a cheaper hybrid route keep E4B as worker while assigning verification
   and synthesis to 26B?
4. Why does Windows RAM fill while Vulkan still reports a large memory budget?

## Models and routing

| Condition | Single | Planner | Implementer | Verifier | Synthesizer |
|---|---|---|---|---|---|
| E4B only | E4B | E4B | E4B | E4B | E4B |
| 26B only | 26B | 26B | 26B | 26B | 26B |
| Hybrid | E4B | E4B | E4B | 26B | 26B |

Models:

- Gemma 4 E4B instruction-tuned, Q4_K_M, 4,977,171,584-byte GGUF,
  131,072-token loaded context.
- Gemma 4 26B A4B instruction-tuned, UD-Q4_K_M,
  16,947,539,744-byte GGUF, 32,768-token loaded context.

The provider-neutral runtime selected the engine for each role. The core schema
does not name Gemma, llama.cpp, Codex, Claude, or another provider.

## Method

Every paired evaluation used the same deterministic concept-coverage fixtures
and forbidden-claim checks. The single condition permits one 4,096-output-token
call plus one repair. Delegation permits four 1,024-output-token calls plus one
repair per role. Both conditions therefore have the same maximum requested
generation ceiling of 8,192 tokens, but delegation uses substantially more
input tokens.

Sampling was not seeded by the neutral engine contract. Results are exploratory
and should be compared as repeated observations, not as a deterministic
leaderboard.

## Quality results

| Run | Single mean | Delegated mean | Delta | Single exact pass | Delegated exact pass |
|---|---:|---:|---:|---:|---:|
| E4B only | 0.6502 | 0.8781 | +0.2278 | 1/9 (11.1%) | 2/9 (22.2%) |
| 26B only | 0.8733 | 0.7556 | -0.1178 | 1/9 (11.1%) | 6/9 (66.7%) |
| Hybrid, E4B single baseline | 0.6173 | 0.8654 | +0.2481 | 0/9 (0%) | 6/9 (66.7%) |

Evaluation identifiers:

- E4B:
  `collaboration-evaluation-f6265b50-6c04-403f-b60c-621526616f12`
- 26B:
  `collaboration-evaluation-8222905e-1b84-4b6b-9a50-c0b16278868b`
- Hybrid:
  `collaboration-evaluation-872654fd-dc14-407e-8569-75f44f974614`

The 26B delegated mean was pulled down by two
`STRUCTURED_ARTIFACT_INVALID` failures in the concurrency fixture. The hybrid
run had one such failure. Both otherwise reached six exact passes. The
evaluation harness now records a failed condition as score zero and continues
the experiment instead of discarding the entire run.

## Interpretation

The experiment does not support "E4B cannot do the work at all." E4B improved
materially under bounded decomposition. It does support a narrower conclusion:
E4B remains unreliable on constraint-dense implementation and release-review
artifacts, even after the context limit was raised and requests above 64K were
proven to work.

Moving all roles to 26B increased single-call completeness and delegated exact
pass rate, but it did not monotonically improve the mean. Larger outputs were
more likely to exceed or corrupt the bounded structured-artifact envelope.
Model size alone therefore does not fix orchestration, output budgeting, or
validation.

The hybrid result is the most useful operating point observed here:

- E4B performs planning and implementation drafts;
- 26B verifies constraints and produces the human-facing synthesis;
- exact pass rate matched the all-26B delegated run in this sample;
- the single baseline remains fast and can be used for low-risk work;
- any structured-output failure remains visible and must not be treated as a
  successful company task.

This is evidence for risk-based routing, not for unattended company-level
autonomy.

## Unified-memory investigation

The initial servers used llama.cpp's default prompt cache limit of 8,192 MiB
per process. During the 26B evaluation its log showed 14 cached prompts using
8,013.089 MiB. Context checkpoints ranged from roughly 324 to 893 MiB each.

Observed Windows snapshots:

| State | Available RAM | Commit charge | 26B working set | 26B private bytes |
|---|---:|---:|---:|---:|
| E4B + 26B, default caches, active evaluation | about 8.3 GiB | about 74.1 GiB | 24.7 GiB | 26.1 GiB |
| 26B only, default cache full | 16.5 GiB | 67.2 GiB | 24.8 GiB | 26.2 GiB |
| 26B only, `--cache-ram 0`, idle | 24.4 GiB | 59.2 GiB | 16.7 GiB | 18.1 GiB |
| 26B only, cache off, after 9,022-token prompt | 24.0 GiB | 59.7 GiB | 17.1 GiB | 18.5 GiB |
| E4B + 26B, both caches off | 20.7 GiB | 65.5 GiB | 17.1 GiB | 18.5 GiB |

`Memory\\Pages Input/sec` was zero in both cache-disabled snapshots. No paging
storm was present at the measurement points.

The measurements confirm:

1. Radeon 8060S uses unified physical memory. AMD Variable Graphics Memory can
   expose a reserved part of that pool as dedicated graphics memory; it is not
   a separate VRAM chip.
2. Vulkan's roughly 114 GB memory budget and Windows CPU-visible memory are not
   independent capacities and must not be added.
3. A process working set/private-byte value and WDDM dedicated-GPU-memory value
   may describe overlapping UMA allocations. Adding them can double-count.
4. The unusually high RAM use was caused mainly by two resident model servers
   plus prompt caches, not by the 26B Q4 weights alone.
5. Disabling the 26B prompt cache saved about 8 GiB without preventing a
   representative 9K-token request.

For repeatable latency and memory benchmarks, load one model at a time. Hybrid
operation necessarily keeps both models resident, so its memory overhead must
be reported separately. A small nonzero cache can later be selected from
measured reuse rather than accepting the 8 GiB default blindly.

## Runtime changes exercised

- role-specific provider-neutral engine selection;
- engine provenance per evaluation condition;
- failure capture that preserves all remaining trials;
- incomplete usage marked unknown when a delegated stage fails before a full
  result can be aggregated;
- offline tests for hybrid routing and failure continuation.

## Limits

- Three synthetic fixtures are insufficient for a general capability claim.
- Exact-term scoring measures coverage, not executable correctness.
- Structured-output failures lose partial token usage in this version.
- Memory counters are snapshots, not an ETW/WPA allocation trace.
- Cache-disabled runs trade repeated-prompt speed for memory and need a longer
  throughput benchmark before becoming a universal default.

## Primary references

- [AMD Ryzen AI MAX+ 395 unified memory and VGM](https://www.amd.com/en/blogs/2025/amd-ryzen-ai-max-395-processor-breakthrough-ai-.html)
- [AMD Variable Graphics Memory FAQ](https://www.amd.com/en/blogs/2025/faqs-amd-variable-graphics-memory-vram-ai-model-sizes-quantization-mcp-more.html)
- [Microsoft WDDM GPU segments](https://learn.microsoft.com/en-us/windows-hardware/drivers/display/gpu-segments)
- [Microsoft guidance on incorrect per-process GPU memory counters](https://learn.microsoft.com/en-us/troubleshoot/windows-client/performance/gpu-process-memory-counters-report-wrong-value)
- [llama.cpp server options](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md)
