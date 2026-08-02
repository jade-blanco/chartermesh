# Longitudinal collaboration study

This study measures whether CharterMesh's explicit team protocol and review
loop improve work relative to a single model. It is a controlled development
experiment, not a claim that a model can autonomously operate a company.

The design answers two separate questions:

1. Does command-mediated team execution improve a deliverable over a single
   model on the same task?
2. How much improvement comes from targeted ordinary-user feedback, generic
   self-review, or simply giving the model another opportunity to work?

## Six paired conditions

Every task is evaluated under a 2 x 3 design. The task, public acceptance
criteria, sealed evaluator, checkpoint, and censoring limits remain the same.

| Architecture | Feedback policy | Purpose |
|---|---|---|
| single | `neutral_repeat` | Extra work without a task-specific hint |
| team | `neutral_repeat` | Team effect with the same neutral repeat |
| single | `fixed_self_review` | Generic model self-review |
| team | `fixed_self_review` | Team effect under generic self-review |
| single | `codex_generalist` | Ordinary-user-style Codex feedback |
| team | `codex_generalist` | Team effect under ordinary-user-style Codex feedback |

The fixed self-review directive is byte-exact:

```text
[최초 제시한 구현 스크립트] 가 구현되었는지 확인하고 피드백할 지점을 찾아서 개선해줘.
```

The neutral condition is necessary. Comparing only self-review with Codex
feedback would confound the content of the feedback with the benefit of one
more inference opportunity.

Condition order follows a seeded six-row Williams square. Across each complete
block of six tasks, every condition occupies every position once and every
ordered first-order carryover occurs once. This balances both single-to-team
and team-to-single warm-up directions, but it does not make the six conditions
compute-equivalent. Team runs normally use more calls, input tokens, and
elapsed time, all of which must be reported.

The feedback arms are not compute-matched either. Neutral repeat and fixed
self-review are fixed text and add no reviewer-model call; every
`codex_generalist` feedback round adds one Codex call whose token usage may be
unknown. The CLI also uses one candidate engine for single and team work, but
the team may invoke it repeatedly for C-level and worker stages. The study
therefore compares complete workflow configurations, not equal-FLOP model
samples.

## Three-condition hybrid C-level canary

`--hybrid-c-level-canary` selects a separate, narrower condition set. It is
intended to answer whether replacing only the team coordinator/C-level model
with an attested Codex exec model improves the same artifact task. It does not
run the six feedback-policy arms above.

| Condition id | Architecture | Engine route |
|---|---|---|
| `single-local-neutral-repeat` | single | Local candidate engine |
| `team-local-neutral-repeat` | team | Local candidate coordinator and specialist |
| `team-codex-c-level-neutral-repeat` | team | Codex exec coordinator/C-level; local candidate specialist |

All three conditions use `neutral_repeat`. They also receive the same
host-owned deterministic orientation plan, so orientation adds no local or
Codex model call. The local candidate engine remains responsible for the
specialist implementation and any public-contract repair. Only the third
condition routes the coordinator/C-level peer-stage calls through the exact
Codex executable, model, timeout, and output boundary committed in the plan.
The Codex CLI is not a worker, repair engine, approver, or source of hidden
evaluation feedback in this canary.

The three conditions use `seeded_cyclic_latin_v1` ordering. This rotates order
across tasks but does not equalize computation. The local team can make more
candidate calls than the single condition, while the hybrid team adds an
external hosted model with different hardware, latency, and unknown token or
cost reporting. This canary therefore compares routed systems, not equal
tokens, equal FLOPs, or local-versus-local models. A quality gain cannot by
itself be attributed solely to the team protocol or C-level role.

The current canary is artifact-only. Select one or more artifact fixtures or
use `--artifacts-only`; a code fixture, `--code-only`, or `--full` fails closed
before live execution. Because Codex exec does not provide trusted token usage,
the plan also requires `limits.maxTotalTokens: null`. In CLI terms, omit
`--max-total-tokens`. Supplying any finite value fails closed rather than
claiming a total-token guarantee the harness cannot enforce. Wall-clock,
model-call, feedback-round, output-size, and other limits still apply.

## Task matrix

The intended reference matrix has one easy, medium, and hard task in each
family:

| Family | Easy | Medium | Hard | Current deterministic gate |
|---|---:|---:|---:|---|
| Code maintenance | 1 | 1 | 1 | Hidden functional tests in an isolated execution backend |
| Product package | 1 | 1 | 1 | Structured product requirements and accountable launch checks |
| Research | 1 | 1 | 1 | Source-linked claims, coverage, and explicit limitations |
| Spreadsheet | 1 | 1 | 1 | Workbook semantic intermediate representation (IR) |
| Word document | 1 | 1 | 1 | Document semantic IR |
| Presentation | 1 | 1 | 1 | Presentation semantic IR |

The CLI longitudinal suite contains 18 tasks with two distinct execution
boundaries. Fifteen non-code tasks cover five families by three difficulty
levels and use semantic IR. Every non-code fixture has a versioned public
request, a sealed oracle, a known-bad baseline, and three deterministically
selected mutations. Suite construction proves that the oracle passes, the
declared baseline failures are detected, and every selected mutation is
killed.

There are also three separate code-workflow reference bindings:

| Difficulty | Reference task |
|---|---|
| Easy | `work-order-transition-001` |
| Medium | `equipment-maintenance-001` |
| Hard | `settlement-refund-001` |

The code adapters implement the same single/team orientation and revision
contracts, but their sealed evaluator runs public and hidden functional cases
through an attested Windows Sandbox backend. The default dry plan and `--full`
include these three bindings alongside the 15 semantic tasks. The plan marks
each task as `semantic_ir` or `attested_vm`, and a live run containing code
must pass the VM preflight before any model call. An `--artifacts-only` report
contains 15 tasks; a `--code-only` report contains three. Neither subset may be
described as the full 18-task mixed report.

Task creation and task execution must be separated. Codex CLI may propose new
public tasks and validation fixtures before a study is frozen, but a live
trajectory must use the committed, hashed suite. The feedback proxy receives
neither oracle requirements nor hidden results. Letting the same live feedback
process generate or revise its own hidden tests would invalidate the result.

### Office artifact boundary

The spreadsheet, document, and presentation tasks evaluate bounded semantic
IR only. They do not create or inspect `.xlsx`, `.docx`, or `.pptx` packages.
Consequently, a pass does not demonstrate:

- OOXML validity or application compatibility;
- spreadsheet recalculation or formula execution;
- pagination, fonts, charts, themes, or layout fidelity;
- visual quality, accessibility, or screen-reader behavior; or
- successful rendering in Excel, Word, PowerPoint, or another office suite.

Those properties require a later render-and-inspect gate. Research fixtures
also measure the declared source-linking contract, not the truth of live web
content. Product-package fixtures measure a structured plan, not a deployed
or market-validated product.

## One trajectory

Each condition follows the same state machine:

```text
matched orientation
  -> synthetic setup approval only when orientation succeeds
  -> implementation submission 1
  -> sealed evaluation
  -> public feedback when not passed
  -> revised submission
  -> ...
  -> sealed pass and synthetic final approval, or right censoring
```

### Setup round and fairness

Team setup does not consume a feedback round. A valid orientation is
automatically approved by the synthetic evaluator; an invalid, failed, or
timed-out orientation records `setupStatus: failed`,
`setupApprovalCount: 0`, and no implementation submission. The single
condition receives a matched model-generated orientation step so the team does
not get an unrecorded planning opportunity. Setup latency, model calls, and
reported usage count toward the condition total.

Beginning with harness `v1alpha5`, the two orientations are schema-matched:
both make one candidate-engine call and return only a concise `plan`. The host
supplies a fixed coordinator-plus-specialist team to `PeerTeamController`,
whose own setup hook makes no additional model call. Dynamic organization
generation is deliberately excluded from this arm and must be measured as a
separate condition.

The study seed controls task and Williams-square condition order only.
Candidate sampling remains the provider default, and orientations are not
shared across feedback arms in this version. Feedback-policy deltas are
therefore exploratory; the P0 canary may support architecture/protocol
conclusions but must not claim a causal feedback-policy effect.

Setup and final approvals are issued by `system:synthetic-evaluator`. They are
experimental bookkeeping events, not production human approvals.

### Portable structured-output boundary

Every study response schema passes through one provider-neutral portability
layer at the candidate-engine boundary. Grammar repetition bounds above 1,000
are omitted from the provider-facing clone because some local structured-output
servers reject otherwise valid schemas while compiling their grammars. The
original schema is never mutated, and the existing application parser and
sealed evaluator still enforce the complete artifact contract after
generation. Oversized bounds are not reduced to 1,000, which would truncate
valid document and code candidates and bias the comparison.

The plan hash commits the portability-policy version, the 1,000-repetition
ceiling, the `omit` action, and post-generation validation against the original
application contract. Changing any part of that policy requires a new plan
hash and approval. A provider grammar-compilation failure is an infrastructure
failure, not evidence that either the single-model or team condition lacks
task capability. Both architectures receive the identical transform.

### Team communication

In the `v1alpha5` Team-Lite condition, only the declared C-level role may
dispatch work or request review. The host fixes one coordinator and one
specialist and enforces one route: coordinator dispatch, specialist response,
coordinator final review. The condition is capped at two internal cycles, one
handoff, three peer-stage model calls, and serial execution. The generic runtime
retains configurable dynamic cycles; these stricter bounds apply to this arm.

Dispatch schemas enumerate the actual declared worker IDs, and review is not a
valid action before a successful handoff. The caller injects the final artifact
schema, instruction, and bounded transport parser. Artifact and code candidates
are emitted as direct typed objects in `request_review.artifact`, not as JSON
escaped inside `StructuredArtifact.deliverable`. Existing runtime callers that
do not inject a contract retain the original `StructuredArtifact` behavior and
may request immediate review unless they opt into `reviewRequiresHandoff`.

Parallel recipients are allowed only with `read_only` or `isolated` artifact
access. Actual parallelism is bounded by both the study limit and the selected
engine's declared concurrency capability. Engines without a compatible
concurrency declaration are serialized.

After a team deliverable is submitted, only the sealed evaluator determines
whether the objective passed. A C-level assertion that the work is complete is
not a passing result. When the evaluator does not pass, the outer trajectory
obtains a new public feedback directive. Only the latest contract-valid, safe,
protocol-valid artifact may become the next SHA-256-bound revision baseline.
An invalid revision remains observable but cannot overwrite that baseline.
Retention never uses sealed score or hidden criterion results.

When the first output violates the public schema or ends with a non-`stop`
finish reason, the host may spend at most one additional model call on a
public-contract repair. The repair sees only public diagnostics, uses the same
task-bound response schema, requires `stop`, and is skipped without a call when
the trajectory budget cannot fit it. It applies symmetrically to single/team
and artifact/code conditions. Its calls, tokens, and latency count toward the
condition; it is a host capability, not unaided model quality.

Every round records raw first-output validity, initial and final public
diagnostics, repair attempts/outcome, effective validity, submitted and retained
hashes, and the retention action. Aggregates expose raw and effective contract
validity separately. Terminal failures
record a sanitized phase, error code, stage index, cycle, and role without raw
model output. A terminal protocol failure counts against protocol compliance
even when it occurs before the first artifact round.

### The 10-feedback checkpoint

One loop means one external feedback directive followed by another
implementation submission. The initial assignment and orientation do not
consume a loop. Therefore the default checkpoint is ten feedback directives
and observes at most eleven submissions:

```text
initial assignment -> submission 1
feedback 1         -> submission 2
...
feedback 10        -> submission 11
```

Setup is excluded. Separate counters retain submissions, feedback directives,
user-facing directives, setup approval, and final approval. The checkpoint
records whether the first sealed pass occurred with at most ten feedback
rounds and the score of submission 11 when the trajectory reaches it. Passing
earlier stops the trajectory and records its actual submission and feedback
count.

The same trajectory then supplies the convergence result. It is not restarted
after the ten-feedback checkpoint, because a restart would discard history and make the
checkpoint and convergence comparisons incomparable.

### Convergence is right-censored

"Run until success" cannot literally be unbounded. A failed model or server
could loop forever, consume unlimited electricity or paid tokens, or repeatedly
produce an identical artifact. The default limits are:

| Limit | Default |
|---|---:|
| Bounded checkpoint | 10 feedback directives, at most 11 submissions |
| Maximum feedback rounds | 50 |
| Wall-clock time | 8 hours |
| Total model calls | 512 |
| Total tokens | No default cap; an explicit cap reserves a conservative input bound before every candidate call and fails closed if usage becomes unknown |
| Consecutive identical artifacts | 3 |
| Consecutive contract-invalid submissions | 3 |
| Parallel agents | 1 |

The contract-invalid guard counts completed externally visible submissions,
not internal calls or handoffs. It therefore gives single and team conditions
the same three failed submission opportunities while stopping changing but
unevaluable artifacts that an identical-hash guard cannot detect. A
contract-valid submission resets the counter.

Stopping reasons are preserved as data: feedback-round limit, wall-clock
limit, model-call limit, token limit, unknown token usage under an explicit
cap, no progress, protocol failure, safety gate, cancellation, or execution error. A censored trajectory is not a
failure-at-infinity and must not be reported as if the time to success were
known.

## Feedback and approval boundary

Codex CLI plays a simulated ordinary-user proxy, not a person. Its records use
`actorType: simulated_user_proxy` and `mayResolveHumanApproval: false`.
It can recommend `looks_good` or request changes, but it cannot resolve a
CharterMesh human approval gate.

The proxy receives only:

- the public objective and implementation request;
- a bounded human-readable artifact view; and
- public check summaries.

It has no input field for hidden tests, oracle answers, private source,
chain-of-thought, tool traces, or internal logs. The implementation attests an
explicit absolute Codex executable by SHA-256 before and after execution, uses
a fresh temporary working directory, and invokes an ephemeral read-only
session with user configuration, repository rules, multi-agent features,
apps, and shell tools disabled. Output is schema-constrained to a recommendation
and at most three short feedback items; code and patches are rejected.

The proxy uses a versioned environment policy for cross-platform Codex
authentication. It preserves the inherited environment, resolves a missing
`HOME` from an absolute `USERPROFILE`, and resolves a missing `CODEX_HOME` as
`HOME/.codex`. The resolved environment is snapshotted when the provider is
constructed, before candidate work starts. Missing, relative, and Windows
drive-ambiguous authentication homes fail closed before the child starts. This
policy is included in the Codex feedback-protocol hash; a change therefore
requires a new approved study plan.

This isolation supports repeatable simulated feedback. It does not make Codex
a real user, remove account or provider cost, or authorize a production
side effect.

## Evaluation and stopping

The feedback process never sees sealed evaluation details. The evaluator
receives the candidate artifact only after contract, protocol, concurrency,
and safety checks pass. A trajectory passes only when the sealed deterministic
evaluator passes it. Model self-assessment and C-level review requests are
necessary workflow events, not evidence of correctness.

A run stops immediately on:

- the first sealed pass;
- any nonzero safety observation;
- a protocol or concurrency violation;
- an explicit cancellation or execution failure; or
- one of the configured right-censor limits.

The safety counters distinguish unauthorized external effects, workspace
escapes, secret access, oracle leaks, duplicate execution, and sandbox-canary
failure. Zero effects in a tool-less or isolated harness demonstrates the
harness boundary, not that the unrestricted model would independently choose
safe behavior.

## Metrics and interpretation

The primary measurements are:

- sealed pass by feedback round 10, or submission 11;
- final sealed pass before censoring;
- submissions, feedback directives, and elapsed time to first pass;
- strict artifact-contract success;
- unauthorized external effects; and
- protocol compliance in the team condition.

Secondary measurements include best and checkpoint score, internal model
calls, provider-reported input/output tokens, handoff count, observed
concurrency, premature review requests, and censor reason. Unknown token usage
remains `null`; it is never converted to zero or an invented cost. When a
total-token cap is configured, candidate calls reserve the UTF-8 byte length
of the request as a conservative upper bound for input tokens and cap requested
output before the call starts. An unmetered Codex feedback call is not started
under that cap.

The report also emits task-paired team-minus-single deltas for each feedback
policy, including checkpoint/final pass rate, best score, feedback rounds,
elapsed time, and model calls. Win/tie/loss counts use task-level best score.
Separate family and difficulty strata make composition effects visible. These
are descriptive pilot statistics, not confidence intervals or a substitute
for repeated independent seeds.

For the hybrid canary, `pairedComparisons` is empty and
`conditionComparisons` contains three task-paired contrasts:

- all-local team versus local single;
- Codex-C-level team versus local single; and
- Codex-C-level team versus all-local team.

Every `rightMinusLeft...` field is calculated as the named right condition
minus the named left condition over matched tasks. Positive pass-rate and
score differences favor the right condition. Positive feedback-round,
elapsed-time, or model-call differences mean the right condition consumed
more of that resource, not that it performed better. `pairedTasks` is the
actual denominator, and `bestScoreWins`, `bestScoreTies`, and
`bestScoreLosses` describe the right condition.

`engineAggregate` groups accounting by condition, engine profile, and reported
model id. It exposes distinct trial and call counts, terminal invocation
states, nullable elapsed time, provider-reported token and cost totals,
`measurementStatus`, and whether evidence came from a Control Plane invocation
or a derived feedback-proxy record. A hybrid
team should therefore show local-candidate and Codex-C-level entries
separately. Unknown token or cost observations propagate as `null`; they are
not zero and must not be imputed. The aggregate attributes observed calls but
does not measure FLOPs, accelerator class, memory bandwidth, energy, or hidden
provider work. A derived Codex-feedback row has unknown tokens, cost, and
elapsed time; it is explicit rather than silently omitted from per-engine call
totals.

Always read `conditionComparisons` and `engineAggregate` together. In
particular, `--codex-max-output-bytes` and schema validation constrain
transport, not inference compute. Codex `maxOutputTokens` is advisory and its
usage can remain unknown. A hybrid win with more calls or elapsed time is a
system-level quality/resource tradeoff, not evidence of a compute-matched
architectural effect.

The unit of comparison is a task trajectory, not an individual round. Ten
correlated feedback loops are not ten independent samples. Results should be paired
by task and seed, report all six conditions, preserve censored observations,
and include calls, tokens, and time beside quality. A single 3-, 15-, or 18-task run
is a development pilot. Production-readiness claims require a separately
governed private holdout, repeated independent runs, failure injection, and
predeclared statistical gates.

## Cost and live-execution policy

Suite generation, validation, mutation checks, and unit tests are offline and
free by default. No model provider is contacted merely by importing or
constructing the study components.

Live inference must be an explicit operator action with configured engines.
An engine can be local, OpenAI-compatible, or another provider-neutral
`ModelEngine`; CharterMesh does not require a specific vendor. The operator is
responsible for any account, energy, or API cost and should set a finite token
cap whenever usage is measurable. A missing provider price means monetary cost
is unknown, not zero.

The hybrid C-level canary is the explicit exception to the finite-token-cap
recommendation: its Codex exec usage is unmeasured, so the CLI requires
`maxTotalTokens: null` and rejects `--max-total-tokens`. This does not make the
run free or unbounded in every dimension; timeout, call-count, feedback-round,
schema, and output-byte gates remain active while monetary cost stays unknown.

The standard condition set binds one candidate engine and configured model for
every candidate role. The hybrid canary is the narrow exception: harness
`v1alpha6` binds its complete condition/role-engine matrix and Codex transport
policy into the plan. An ad-hoc `engineForRole` resolver remains rejected at
the live boundary; any other heterogeneous model combination needs its own
versioned, hash-bound condition set.

The standard plan also reserves and commits the
`codex-cli-ordinary-user` profile for derived feedback accounting; a candidate
engine cannot reuse it. The live standard runner accepts only the exact frozen
default-spawn feedback provider with that ID and preflights its executable
before any candidate starts. For the hybrid route, the Codex adapter freezes
its instance, manifest, and prototype and verifies the approved executable
before the study as well as before and after each call.

The Codex feedback arm and hybrid C-level route additionally require an
explicit absolute executable path and expected SHA-256. The process is never
discovered or launched as an offline test side effect.

## Run the CLI study

`evaluate-workflow` is dry by default. With no selector, a dry run plans all 18
tasks but does not start a model or VM. A live run requires exactly one
selector mode: one or more repeated `--fixture` values, `--full`,
`--artifacts-only`, or `--code-only`. For an approvable live plan, include the
candidate engine and Codex bindings in the dry command:

```powershell
node bin/chartermesh.mjs evaluate-workflow `
  --target TARGET `
  --fixture product-package-easy-001 `
  --engine-id CANDIDATE_ENGINE_ID `
  --codex-executable C:\absolute\path\to\codex.exe `
  --codex-sha256 LOWERCASE_SHA256 `
  --codex-model CODEX_MODEL_ID `
  --checkpoint-feedback-rounds 10 `
  --max-feedback-rounds 50 `
  --max-model-calls 512 `
  --max-consecutive-contract-invalid-submissions 3 `
  --max-wall-clock-minutes 480 `
  --max-parallel-agents 1 `
  --json
```

This command performs no model inference. Review the returned plan and copy
its `planHash`. An unbound dry plan reports `liveReady: false` and cannot be
used for live execution. Then repeat the same plan-defining options and add
`--live` plus the exact approval token:

```powershell
node bin/chartermesh.mjs evaluate-workflow `
  --target TARGET `
  --fixture product-package-easy-001 `
  --engine-id CANDIDATE_ENGINE_ID `
  --codex-executable C:\absolute\path\to\codex.exe `
  --codex-sha256 LOWERCASE_SHA256 `
  --codex-model CODEX_MODEL_ID `
  --checkpoint-feedback-rounds 10 `
  --max-feedback-rounds 50 `
  --max-model-calls 512 `
  --max-consecutive-contract-invalid-submissions 3 `
  --max-wall-clock-minutes 480 `
  --max-parallel-agents 1 `
  --live `
  --approve PLAN_HASH `
  --json
```

### Run the hybrid C-level canary

Choose an artifact fixture and include `--hybrid-c-level-canary` in the dry
plan. Do not pass `--max-total-tokens`:

```powershell
node bin/chartermesh.mjs evaluate-workflow `
  --target TARGET `
  --fixture product-package-easy-001 `
  --hybrid-c-level-canary `
  --engine-id LOCAL_CANDIDATE_ENGINE_ID `
  --codex-executable C:\absolute\path\to\codex.exe `
  --codex-sha256 LOWERCASE_SHA256 `
  --codex-model CODEX_MODEL_ID `
  --codex-timeout-ms 120000 `
  --codex-max-output-bytes 1048576 `
  --checkpoint-feedback-rounds 10 `
  --max-feedback-rounds 50 `
  --max-model-calls 512 `
  --max-wall-clock-minutes 480 `
  --max-parallel-agents 1 `
  --json
```

The dry response must contain `conditionSet: hybrid_c_level_canary_v1`,
`codexExecutionPurpose: c_level_model_engine`, the three condition IDs
documented above, `liveReady: true`, and a 64-character `planHash`. Review the
routing and bindings. Then repeat the same plan-defining options exactly and
add only the live authorization:

```powershell
node bin/chartermesh.mjs evaluate-workflow `
  --target TARGET `
  --fixture product-package-easy-001 `
  --hybrid-c-level-canary `
  --engine-id LOCAL_CANDIDATE_ENGINE_ID `
  --codex-executable C:\absolute\path\to\codex.exe `
  --codex-sha256 LOWERCASE_SHA256 `
  --codex-model CODEX_MODEL_ID `
  --codex-timeout-ms 120000 `
  --codex-max-output-bytes 1048576 `
  --checkpoint-feedback-rounds 10 `
  --max-feedback-rounds 50 `
  --max-model-calls 512 `
  --max-wall-clock-minutes 480 `
  --max-parallel-agents 1 `
  --live `
  --approve PLAN_HASH `
  --json
```

`--codex-max-output-bytes` defaults to 1,048,576 bytes and accepts 1 through
16,777,216. It hard-bounds combined Codex process output and the structured
last-message file. It is not a token limit. The per-call `maxOutputTokens`
sent to Codex exec is prompt-only and advisory because this CLI transport
cannot prove the provider enforced it. The hard boundaries are the process
timeout, call-count limits, required response schema, and output-byte limit.
Codex token and cost usage remain unknown when the CLI does not report them.

Changing the executable digest, model, timeout, output-byte bound, candidate
profile, selected task, limit, seed, routing policy, or any other committed
field produces a different plan hash. A previous approval cannot authorize
the changed command, and a mismatched `--approve` is rejected before either
engine is started.

The plan hash commits the selected task hashes and execution boundaries,
condition matrix, the applicable `seeded_williams_square_v1` or
`seeded_cyclic_latin_v1` ordering, harness and feedback
adapter versions, the exact neutral/fixed intervention hashes, the Codex
review protocol hash, seed, every trajectory limit, candidate runtime profile,
the versioned structured-output portability policy and its affected keywords,
Codex executable/model/timeout/output-byte bound, and, when code is selected,
the sandbox backend
id, collected code-provenance hash, launcher commitment, and launcher
attestation mode. The live runner rechecks the
entire limits object and all applicable bindings. It fails if the approval
token differs from the regenerated plan hash.

Harness `v1alpha5` additionally commits the fixed-team manifest hashes, exact
Team-Lite controller bounds, contract-repair prompt and limits, and the
orientation-sampling disclosure. Changing any of these requires a new approval
hash. Harness `v1alpha6` additionally commits the selected condition set,
closed role-engine routes, host-owned orientation hash, Codex model-engine
protocol, and output-byte boundary.

A standard full run uses `--full --acknowledge-large-run`; 18 tasks by six
conditions means 108 trajectories and can make many candidate and Codex calls.
The hybrid canary rejects `--full`; its largest supported selection is 15
artifact tasks by three conditions, or 45 trajectories. Live
`--artifacts-only` and standard `--code-only` runs also require
`--acknowledge-large-run`. Start with one fixture.

Code selection uses the current Node executable by default and locates
`wsb.exe` normally. To select different binaries, include their absolute paths
in both the dry and live commands:

```powershell
--code-runtime-executable C:\absolute\path\to\node.exe `
--wsb-executable C:\absolute\path\to\wsb.exe
```

The runtime digest is part of collected code provenance. The plan stores a
launcher commitment rather than its absolute path. A code plan is live-ready
only with `file_sha256`; unresolved `command_name_only` plans remain useful for
diagnosis but cannot run. The backend re-attests the exact launcher immediately
before and after every host invocation, while local paths stay out of the
published report. Live code execution also fails closed unless the backend
manifest and live canary satisfy the VM, network, process, timeout, and
output-boundary requirements. Sandbox infrastructure failures are recorded as
trial execution failures, never as candidate safety violations.

The final report is written under
`.chartermesh/exports/<study-id>.json`. The CLI also creates a study-specific
Control Plane at `.chartermesh/evaluations/<study-id>/state.db`, isolated from
the target's operational database. Each trajectory owns a WorkItem, parent
Attempt, invocation records, and hash-bound child-stage lineage. Finalizing a
trajectory submits its evidence artifact and leaves the evaluation WorkItem in
`review_pending`; the simulated setup/final approvals are deliberately not
written as production approval decisions.

The JSON checkpoint is atomically updated after each completed trajectory, and
an atomic per-plan lock prevents concurrent CLIs from duplicating calls. A
normal exception changes the checkpoint to `failed` without copying the error
message into the publishable evidence. After a forced termination, first
confirm that the old process stopped, then repeat the exact approved command
with `--restart-checkpoint`. CharterMesh preserves the abandoned checkpoint and
Control Plane, and starts a fresh isolated database; it does not silently merge
or resume a partially completed trajectory.

Every Windows Sandbox start is preceded by a flushed, exact-schema session
journal. A later invocation will not start another VM until the journal's exact
sandbox ID is proven stopped through the attested launcher; a live owner or an
ambiguous stop fails closed. Codex termination similarly escalates from
`SIGTERM` to `SIGKILL` and requires a child `close` event. If either process
cannot be proven settled, the study retains its lock and does not delete the
still-owned temporary directory.

The final report retains both the full approved plan hash and the canonical
approved-plan JSON. A model-engine boundary checks provider identity before
any orientation, team protocol, or candidate output is parsed. Candidate calls
must report the configured model id. Missing, mismatched, or drifting provider
identity is classified as
`provider_identity_mismatch`, so a server that silently swaps models cannot be
published as the requested model. A non-null provider system fingerprint is
also pinned across all tasks and conditions in the study; a cross-trial change
aborts the study before a mixed-provenance final report is written.

## Current implementation boundary

The current implementation provides:

- `runWorkflowTrajectory` for one longitudinal condition;
- `runWorkflowStudy` for the six-condition standard matrix or three-condition
  hybrid C-level canary, their committed orderings, paired contrasts, and
  family/difficulty strata;
- fixed, neutral, and attested Codex simulated-feedback providers;
- an 18-task mixed suite: 15 sealed semantic-IR tasks and three attested-VM
  code reference tasks;
- a deterministic artifact evaluator and human-readable projections;
- an experimental command-mediated `PeerTeamController`;
- a dry-by-default `evaluate-workflow` command with explicit live opt-in and
  plan-hash approval; and
- isolated Control Plane lineage and trial evidence ending in
  `review_pending`.

The actual Codex subprocess path is not proven by mocked or offline tests. A
publishable result needs a recorded live single-fixture smoke using the exact
attested executable and requested model. Likewise, implementing the three code
adapters does not prove the VM path ran: the platform's sandbox feature and
live canary must succeed, and on Windows feature enablement may require a
restart. Reports must label either path unverified when that environmental run
has not occurred.

The peer-team controller performs bounded `ModelEngine` calls; it does not
create independent OS processes or grant workers tools, credentials, or
approval authority. The current workflow CLI has durable Control Plane
lineage and the code/VM path, but still lacks automatic partial-study resume.

These boundaries must remain in every published report. Removing them would
turn a useful comparative experiment into an unsupported autonomy claim.
