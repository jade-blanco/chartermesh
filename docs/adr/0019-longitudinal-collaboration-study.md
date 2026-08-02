# ADR 0019: Use a six-arm longitudinal study for collaboration effects

- Status: accepted
- Date: 2026-07-31
- Amended: 2026-08-02

## Context

The existing collaboration smoke test compares one single-model result with a
fixed four-stage delegated result. It is useful for transport, schema, and
bounded role-routing checks, but it cannot answer whether improvement came
from collaboration, extra inference calls, repeated self-review, or useful
user feedback. It also does not measure how many revisions and how much time a
condition needs before satisfying a functional objective.

The requested experiment uses Codex CLI as a person-like reviewer, ten review
loops, dynamic team handoffs, and continued execution until the objective is
met. Those requirements need explicit methodological and safety boundaries:

- Codex is still a model and cannot become the production human approver;
- repeated rounds in one trajectory are correlated observations;
- a team consumes different compute from a single model;
- a model's claim that it is finished cannot be the correctness oracle; and
- an actually infinite retry loop is operationally unsafe and statistically
  unreportable.

## Decision

### Six paired conditions

Use a 2 x 3 design:

```text
architecture: single | team
feedback:     neutral_repeat | fixed_self_review | codex_generalist
```

The neutral-repeat arm controls for another opportunity to infer. The fixed
self-review arm uses the experiment owner's byte-exact Korean instruction.
The Codex arm requests outcome-focused feedback in the style of an ordinary
user, not a prompt engineer. Every task runs in all six conditions, and a
seeded Williams square balances condition positions and ordered first-order
carryover across each complete six-task block.

This is directive-matched, not compute-matched. Reports must include calls,
reported tokens, and elapsed time so that a quality improvement cannot be
presented without its resource cost. Neutral and fixed feedback add no reviewer
inference, whereas the Codex arm adds one reviewer call per feedback round.
Team submissions can add several C-level and worker calls. The six arms compare
workflow configurations, not equal-FLOP samples.

### Simulated-user and approval boundary

Codex feedback is recorded as `simulated_user_proxy` with
`mayResolveHumanApproval: false`. It receives only public task text,
human-readable output, and public check summaries. It never receives sealed
oracle requirements or hidden outcomes, and its output may contain feedback
only, not an implementation or patch.

The experiment records setup and final approval as synthetic-evaluator events.
They satisfy experimental state transitions only. No model, including Codex or
the C-level role, can satisfy a production human-approval requirement.

### Matched orientation and command-mediated teams

Team setup is outside the feedback-round count. Beginning with harness
`v1alpha5`, both conditions use the same one-field planning schema. The study
runtime, rather than the candidate model, supplies a fixed two-role team with
one coordinator and one specialist. This removes model-generated organization
syntax as an artifact-only failure surface while leaving dynamic team design as
a separate capability to test in a future `team_dynamic` arm. A failed plan
records zero setup approvals and ends before implementation. Setup calls,
usage, and latency remain part of total resource measurements.

The Team-Lite condition uses an experimental peer-team controller with a
host-owned deterministic state shape: one coordinator dispatch, one specialist
response, then one coordinator final review. Its limits are two internal
cycles, one handoff, three peer-stage calls, and effective parallelism one.
The generic runtime keeps configurable dynamic cycles, but this comparison arm
removes model-controlled redispatch and unbounded transcript growth.

The controller constrains dispatch targets to the declared worker-role enum and
does not expose the review action until at least one handoff succeeds. The host
injects a caller-owned final-artifact schema and transport parser. Artifact and
code studies therefore submit their candidate object directly in
`request_review.artifact`; they never escape candidate JSON into a
`StructuredArtifact.deliverable` string. The application parser remains the
acceptance authority after transport, so a schema-invalid candidate is a
contract-invalid submission rather than an automatic claim of success.

The host may make one bounded repair call after a public-contract-invalid or
non-`stop` first output. It supplies only public diagnostics and the same
task-bound schema, requires a `stop` finish, and skips without a call if the
remaining trajectory budget cannot fit it. Calls, usage, and latency are
charged to the originating condition. Reports preserve raw first-output
validity and diagnostics separately from effective post-repair validity and
repair outcome.

The sealed evaluator, not the C-level role, decides whether a submitted
artifact passes. If it does not pass, the outer trajectory supplies the next
public feedback directive. A contract-valid, protocol-valid, safe submission
becomes the next SHA-256-bound revision baseline. A later contract-invalid or
untrusted submission remains visible for feedback but cannot replace that
baseline. When no valid baseline exists, the next attempt starts without a
prior artifact. The sealed score never selects the retained artifact, because
that would leak hidden-oracle information through the trajectory.

### Checkpoint and convergence

Use one continuous trajectory for both analyses:

- feedback round 10, which can produce submission 11, is the bounded
  checkpoint;
- an earlier sealed pass stops immediately;
- otherwise the same history continues toward convergence; and
- setup is excluded from the feedback-round count.

The initial implementation is submission 1 and consumes no feedback round.
Each external feedback directive enables one next submission. Thus ten
feedback loops mean at most eleven submissions. Reports retain separate
submission, feedback, user-directive, setup-approval, and final-approval
counts.

Feedback rounds within one trajectory are not independent trials. Task-level
trajectories are the comparison unit.

### Right censoring instead of an infinite loop

Convergence runs are finite and right-censored. Defaults are a ten-feedback
checkpoint, at most 50 feedback rounds, eight hours, 512 model calls, three
consecutive identical artifacts, three consecutive contract-invalid
submissions, one parallel agent, and an optional total token cap.
Contract-invalid counting is submission-based rather than internal-call-based,
so single and team conditions receive the same failed artifact opportunities;
a contract-valid submission resets it. Cancellation, safety failure, protocol
failure, and execution error also stop a run.

The report preserves the censor reason. A censored trajectory is neither a
success nor proof that the condition would never succeed.

### Sealed task suites

Use difficulty-stratified code, product-package, research, spreadsheet,
document, and presentation tasks. Public instructions and sealed deterministic
evaluation data are frozen and hashed before any live condition starts.

The mixed CLI suite implements 18 tasks. Fifteen non-code tasks cover five
families by easy, medium, and hard; each has an oracle, known-bad baseline, and
seeded mutations verified during suite construction. Three easy/medium/hard
code-workflow references use the same trajectory contract but require an
attested VM sandbox for public and hidden functional cases. Plans and reports
label each task boundary as `semantic_ir` or `attested_vm`; the 15-task and
three-task selector modes must not be presented as the full mixed suite.

Spreadsheet, document, and presentation v1 tasks evaluate semantic IR, not
OOXML files, rendering, visual quality, formula execution, accessibility, or
office-application compatibility. Research tasks evaluate a declared
source-linking structure, not live factual truth. These limitations are part
of the report contract.

### Metrics

Primary outcomes are pass by feedback round 10 (submission 11), final pass before censoring,
feedback count and elapsed time to first pass, contract success, protocol
compliance, and unauthorized external effects. Secondary outcomes include
partial score, calls, reported tokens, handoffs, observed concurrency,
premature review requests, and censor reason.

Unknown usage remains unknown. When an operator configures a total-token cap,
each candidate call reserves the request UTF-8 byte length as a conservative
input-token upper bound and limits requested output before inference. An
unmetered reviewer is not invoked; otherwise unknown usage censors the
trajectory instead of silently bypassing the cap.
Reports include task-paired team-minus-single deltas per feedback policy and
family/difficulty strata, but a single seeded pilot does not provide an
inferential confidence interval. Zero external effects under a tool-less or
isolated harness is evidence about containment, not proof of an unrestricted
model's judgment.

### Dry plan, live opt-in, and isolated evidence

`evaluate-workflow` produces a non-inference plan by default. Live execution
requires `--live`, an explicit candidate engine, Codex executable/model
bindings, and `--approve` with the regenerated plan's exact SHA-256. The hash
commits the sealed task bindings, condition matrix, seed, complete trajectory
limits, harness/feedback-adapter versions, exact fixed intervention hashes,
the Codex review-protocol hash, fixed-team manifests, exact Team-Lite
controller bounds, the last-valid retention policy, the repair prompt and
limits, orientation-sampling disclosure, candidate runtime profile, Codex
binding, and any selected code-sandbox
identity, provenance, launcher commitment, and launcher-attestation mode. The
live runner rechecks those bindings and
limits. Full, artifact-only, and code-only live runs additionally require
explicit large-run acknowledgement.

The design seed controls task and condition ordering, not provider sampling.
Harness `v1alpha5` does not share a model-generated orientation across feedback
arms, so feedback-policy differences remain exploratory rather than causal.

The plan also binds a versioned structured-output portability policy. The
candidate-engine boundary clones every response schema and omits grammar
repetition bounds above 1,000 before provider transmission. The original
application parser still enforces the full contract after generation. Omitting
an oversized provider-side bound avoids both local grammar-compiler failures
and the experimental bias that would result from truncating legitimate
document or code candidates to 1,000 characters. Both architectures receive
the same transform. A policy or ceiling change therefore produces a different
plan hash and requires fresh approval. Earlier v1alpha1 smoke outputs affected
by grammar compilation are infrastructure diagnostics, not comparison data.

The Codex proxy requires an absolute executable path and expected SHA-256,
re-attests it before and after execution, and runs in a fresh ephemeral
read-only context with host extensions and shell access disabled. A live plan
containing code also runs the attested VM preflight before the first model
call.

The proxy also applies a versioned authentication-environment policy. A
missing `HOME` is resolved from an absolute `USERPROFILE`, and a missing
`CODEX_HOME` is resolved as `HOME/.codex`. The environment is snapshotted when
the provider is constructed, before any candidate call; invalid, relative, and
Windows drive-ambiguous values fail closed. The policy is committed by the
Codex feedback-protocol hash so environment normalization cannot change beneath
an approved plan.

Live CLI runs use a study-specific Control Plane database rather than the
target's operational database. Model invocations and peer-team child Attempts
are durable there. Trial finalization submits an evidence artifact, which
leaves the WorkItem in `review_pending`; synthetic report approvals are not
converted into Control Plane human decisions.

Provider model identity is checked at the engine boundary before response
parsing, and its non-null system fingerprint is pinned across the study.
Parallel team calls reserve from one shared token budget before they start.
Unsettled model or VM cancellation is fatal to the study. Windows Sandbox IDs
are journaled before launch and recovered only after an attested stop.

The v1 plan binds one candidate engine and configured model for all candidate
roles. Unbound role-to-engine resolver functions are rejected during live
execution. Heterogeneous role teams require a future versioned role-engine
matrix whose complete mapping and runtime identities are part of the approved
plan hash.

CharterMesh does not guarantee zero monetary cost for a live run. Provider
pricing may be absent or unknown; the operator owns engine selection and
resource limits.

## Consequences

- Collaboration, targeted feedback, generic self-review, and mere repetition
  become separately observable effects.
- The ten-feedback result and time-to-convergence result share one auditable
  history instead of two incomparable restarts.
- Dynamic role handoffs can be measured without making provider-native agents
  part of the core schema.
- Team improvements must be interpreted alongside their additional compute
  and latency.
- Codex feedback remains useful without weakening the human-approval boundary.
- Censoring prevents a stalled model or server from causing an unbounded run.
- Provider grammar limits do not silently narrow the accepted artifact, and
  the exact portability transform is part of the approved protocol.
- A 3-, 15-, or 18-task development study cannot establish autonomous-company
  readiness; a private holdout and repeated independent trials remain
  necessary.
- The peer-team controller and CLI are experimental. Automatic partial-study
  resume remains follow-up work.
- Mocked/offline verification does not prove the real Codex subprocess or VM
  sandbox path. A report must say when either environmental smoke run is still
  unverified, including when Windows Sandbox activation is awaiting a restart.

## Alternatives rejected

- **Treat Codex as the human approver.** This would make a model authorize
  another model and violate the product's approval semantics.
- **Compare only Codex feedback with self-review.** This cannot isolate the
  effect of an additional inference opportunity.
- **Count ten feedback loops as ten independent samples.** They share model state,
  artifacts, and feedback history.
- **Accept C-level completion as pass.** Self-declaration is not functional
  evidence.
- **Retry without a bound.** This permits unlimited spend and yields no honest
  failure or censoring semantics.
- **Score Office files from semantic fields alone.** Semantic IR cannot support
  rendering, compatibility, or visual-quality claims.
