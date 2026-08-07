# ADR 0021: Bind artifact and producer report separately and benchmark the review projection

- Status: accepted
- Date: 2026-08-02

## Context

ADR 0020 defines the Decision Packet as the provider-neutral projection that
compresses an artifact, its evidence, criteria, and unresolved exceptions into
one verifiable human decision. That projection addresses an important design
problem, but ordinary operating telemetry cannot establish that it improves
human understanding or decision quality.

There is also an identity ambiguity to remove before evaluating the review
surface. The artifact is the thing being reviewed. A producer-authored summary,
check list, risk list, confidence, or next-action list is a report about that
artifact. Combining both into one content hash makes it difficult to tell
whether the deliverable or merely its description changed, and can encourage
a reviewer to treat a model claim as artifact evidence.

CharterMesh needs a small, repeatable regression check for its review
projection without pretending that a model proxy is a person or that ten
synthetic cases establish a causal effect.

## Decision

### Separate immutable subjects

The actual artifact and the producer report are separately immutable and
separately SHA-256 bound.

- The artifact hash identifies the exact deliverable bytes. The artifact
  subject identity binds that digest with its media type.
- The producer-report hash identifies a canonical, schema-bounded sidecar.
- A review binding commits both hashes and the applicable public decision
  contract.
- A Decision Packet for the artifact review also commits the report identity
  when that report is presented to the reviewer.

Changing either subject invalidates the prior combined review binding. A new
producer report cannot silently retain an old packet merely because the
artifact is unchanged, and a new artifact cannot inherit an old report as if
the producer had described the new bytes.

The sidecar uses
`chartermesh.dev/artifact-producer-report/v1alpha1`. Producer-report checks
remain `claimed` whether the source is `model_reported` or
`runtime_compiled`; deterministic runtime formatting is not independent
verification. The sidecar cannot authorize a tool, satisfy a human approval,
or replace the artifact.

`chartermesh.dev/decision-packet/v1alpha2` canonically commits
`producerReportHash` in addition to the artifact subject and existing review
inputs. SQLite schema v12 stores the sidecar JSON, canonical hash, and byte
size on the artifact row. Migration from v11 preserves existing artifacts as
report-absent rows.

### Pure review projection

The benchmark consumes a bounded human-review view generated as a pure
projection from explicitly supplied, hash-bound values. Rendering cannot call
a model, tool, network, clock, mutable database, or sealed evaluator. The same
inputs and renderer version produce the same view identity.

Two projections are compared:

- `raw`: the exact bounded artifact, tool-call, or user-input subject preview
  and, for artifact cases, the separately labelled producer report, without
  Decision Packet criterion/evidence/exception projection;
- `decision_review`: the same subject preview and optional producer report
  plus the bound Decision Packet decision context.

The Decision Packet condition does not replace or hide the artifact. A review
surface must present the exact bounded artifact preview tied to the packet's
subject identity and keep the decision action unavailable unless both packet
and artifact are present. The raw condition does not invent evidence
classification in the browser.

### Twenty-call fixed regression

A versioned suite contains ten fixed fictional cases. Every case runs once in
each view condition, yielding exactly twenty stateless Codex reviewer calls.
Each call receives only its condition-specific review view and a bounded
structured response schema. Calls use fresh ephemeral state and do not share
conversation, case answers, workspace access, tools, or prior output.

The reviewer executable, model, isolation policy, timeout, output bound,
response schema, and exact harness-source digest are committed by the plan.
Ordinary settled call or schema failures remain in the denominator. Identity,
attestation, or unsettled-process containment failures abort before another
call starts.

Each case has a sealed deterministic oracle containing the acceptable
decision, required finding/reference bindings, critical error rules, and
scoring rules. The
oracle is not included in the reviewer input or review renderer. No LLM judges
the measured reviewer.

### Approval and report boundary

The CLI command is `evaluate-decision-review`. It is dry by default.
Live execution requires the exact SHA-256 of the regenerated plan, which binds
the suite, subject hashes, condition schedule, protocols, model identity,
limits, oracle commitment, and public-report policy. Live execution also
requires the bound Codex executable path, executable SHA-256, and model ID;
the path itself is not included in the publishable plan.

The final public report is created from a field allowlist. It contains bounded
identities, hashes, structured answers, oracle result codes, aggregate paired
deltas, calls, nullable usage and cost, latency, sanitized failures, and safety
counters. It excludes artifact/report content, rendered views, prompts, raw
model output, hidden oracle data, environment values, credentials, absolute
paths, host/user/process identity, and arbitrary provider payloads.

Running, paused, or failed checkpoints, locks, evaluation databases, temporary
files, and abandoned outputs are not public reports.

### Fail-closed pause and resume

The runner writes and flushes the active invocation before every model call. Quota
or rate-capacity exhaustion and an authentication boundary pause the study
without scoring the attempted call after the child process is known to have
settled. An operator signal may pause only between calls, before the next
active invocation is recorded. Ctrl+C during an active model call leaves an
unknown outcome and fails closed. A checkpoint that is `running`, `failed`,
still active, or otherwise ambiguous cannot be resumed and never authorizes an
automatic retry.

The checkpoint is local operational state at
`.chartermesh/evaluations/<benchmarkId>/checkpoint.json`. It commits the base
plan and an immutable, contiguous completed-trial prefix. The final allowlisted
report alone is written under `.chartermesh/exports/`.

Resume is also dry by default. The operator supplies
`--resume --account-context same|changed|unknown`; the resulting resume plan
binds the exact paused-checkpoint hash, completed-prefix hash, remaining
schedule, base reviewer and source binding, and a new anonymous execution
segment. Live continuation requires a fresh exact resume-plan approval and
rereads the checkpoint under the lock before starting another call. The model,
executable digest, limits, suite, protocol, and harness-source digest
must equal the base plan. Source changes invalidate all earlier base and resume
plan hashes.

Each resumed segment binds its exact source checkpoint, ordered prior-segment
chain, source process-attempt count, and approved resume-plan hash. Live mode
consumes that approval with an exclusive local receipt before a later model
process can start. A stale lock is recoverable only when its owner is dead and
the exact approved checkpoint remains cleanly paused with no active invocation.
State-path symlink and junction components are rejected, and bounded JSON is
read from one checked file handle.

Account context is operator-declared and unverified. CharterMesh records no
account name, email, authentication path, credential, or credential hash.
Every resume creates a new execution segment and therefore confounds a strict
uninterrupted single-reviewer benefit claim. `changed` or `unknown` preserves
the operational value of a completed run while additionally disclosing the
declared account-continuity uncertainty.

The local hash chain and used-approval receipts are not signatures and do not
claim resistance to a malicious concurrent local writer, whole-directory
rollback, or storage-device loss. Checkpoint files are flushed before atomic
rename; parent-directory flushing is best-effort where the filesystem permits
it. The final report carries the completed-prefix hash, segment-chain head, and
an allowlisted report-body hash.

## Invariants

1. Artifact bytes and producer-report sidecar never share one identity.
2. For an artifact case, the artifact and report hashes (when a report is
   present) are both part of the measured review binding.
3. A report change or artifact change invalidates the prior combined binding.
4. Producer-authored claims are not verified evidence.
5. The pure renderer cannot observe the sealed oracle or mutable runtime
   state.
6. Raw and `decision_review` conditions use the same exact subject, optional
   report, public contract, reviewer binding, and deterministic oracle.
7. The first suite accounts for ten cases, two conditions, and twenty calls;
   failed calls stay in the denominator.
8. Reviewer calls are stateless and have no operational workspace, tool, web,
   app, delegation, credential, or approval capability.
9. An exact approved plan hash is required before any live reviewer call. The
   runner regenerates and compares the complete plan rather than trusting
   mutable fields next to a retained hash.
10. A Codex recommendation never resolves a production human approval.
11. Public evidence is allowlisted; unknown nested fields are dropped rather
    than copied and redacted.
12. Results are descriptive product-regression evidence only.
13. A benefit label cannot trade away consequence correctness, reference
    binding, complete case passes, protocol validity, or safety for shorter
    input.
14. Each model call is durably marked before process start; an active or
    ambiguous attempt cannot be retried automatically.
15. A resume continues only an exact immutable completed prefix and requires a
    newly approved resume-plan hash.
16. Account-context declarations are not account-identity attestations, and no
    authentication material or identifier is stored.

## Interpretation boundary

The benchmark may show that, for the exact fixed cases and reviewer, the
`decision_review` view changed acceptable-decision rate, required and
reference-bound findings, critical errors, structured-output reliability,
calls, tokens, or latency relative to the raw view.

It cannot show that:

- a person would make the same decisions;
- the Decision Packet caused an improvement in human comprehension;
- the result generalizes beyond the fixed suite and reviewer binding;
- a statistically meaningful effect was established;
- the reviewer model is an independent human approver; or
- CharterMesh is ready for autonomous company operation.

Any configured pass threshold is a predeclared engineering regression gate,
not an academic or causal conclusion. The report must present resource and
failure measurements alongside quality deltas because the two views need not
be token- or latency-matched.

## Consequences

- Review identity becomes honest about the difference between a deliverable
  and the producer's description of it.
- Decision Packet changes can be tested against a frozen paired suite before
  release without collecting private operational work.
- Stateless model review provides a repeatable development signal while
  preserving the production human-approval boundary.
- A pure renderer makes the measured view hashable and prevents hidden oracle
  or runtime state from leaking into one condition.
- Exact-plan approval prevents a changed suite, model, renderer, or limit from
  reusing an earlier live-run authorization.
- Exact resume-plan approval preserves completed work without converting a
  quota, authentication, or operator interruption into permission to retry an
  unknown call.
- Anonymous execution segments make account-boundary uncertainty visible
  without collecting account or credential identifiers.
- Allowlisted reports can become GitHub reference evidence without publishing
  local paths, prompts, artifacts, databases, or credentials.
- A later blinded human-comprehension study remains necessary before making a
  claim about people. Its protocol and consent requirements are outside this
  ADR.

## Alternatives rejected

- **Treat the producer report as the artifact.** This makes a claim about a
  deliverable indistinguishable from the deliverable itself.
- **Use one hash for artifact and report.** A changed description or changed
  deliverable could not be reasoned about independently.
- **Ask the same reviewer session to inspect all cases.** Prior cases and
  answers would introduce avoidable carryover and hidden context.
- **Let an LLM judge another LLM.** This replaces a fixed product regression
  with an unsealed, model-dependent score.
- **Use operational approval logs as ground truth.** They have no sealed answer
  and cannot establish correctness or comprehension.
- **Publish checkpoints or raw traces and redact them later.** Arbitrary nested
  payloads and local paths are safer to omit through an allowlist.
- **Automatically restart the last scheduled call.** A crash can occur after
  provider acceptance but before local result persistence, so automatic retry
  could duplicate a billed or stateful call and corrupt the comparison.
- **Persist account email, auth home, or credential fingerprints.** These data
  do not prove that two calls used the same reviewer entitlement and create an
  unnecessary privacy and credential-linkage risk.
- **Describe the result as a human or causal study.** No people are measured,
  and one fixed twenty-call run does not support that claim.
