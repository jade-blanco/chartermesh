# Decision-review proxy benchmark

This document describes the implemented small product-regression benchmark
for the human review surface created from an exact decision subject, an
optional producer report, and an optional Decision Packet. The CLI command is
`evaluate-decision-review`; this source
revision uses benchmark protocol `decision-review-proxy-v1alpha2` and fixed
suite `decision-review-fixed-10-v1`.

The benchmark asks a narrow product question:

> Does the Decision Packet review view help a bounded, stateless reviewer make
> the expected decision and identify the expected review issues more reliably
> than the raw review view for the same immutable decision subject?

It does not measure whether CharterMesh can operate a company, whether a model
is a human substitute, or whether people understand the interface better.

## Status and claim boundary

This is a deterministic development and release-regression design. It is not:

- a human-subject study;
- a causal estimate of the effect on people;
- an academic benchmark or statistical significance claim;
- a general model-quality benchmark;
- evidence that model review can satisfy a `human:*` approval; or
- evidence that the reviewed artifact is safe to deploy or publish.

The reviewer is a stateless Codex process acting as a consistent review proxy.
Its answer is experimental evidence only. It cannot mutate the operational
Control Plane, approve a production WorkItem, execute a tool, or resolve a
human gate.

Results must be described as paired, descriptive product-regression results
for the exact suite, reviewer binding, plan, and run. A ten-case run is too
small to justify population-level or causal conclusions.

## Immutable input binding

Each fixed case contains four logically separate inputs:

1. the exact artifact, tool-call, or user-input decision subject;
2. an optional structured producer-report sidecar for an artifact;
3. the public review contract and allowed decisions; and
4. a sealed deterministic oracle that is unavailable to the reviewer.

For an artifact case, the artifact and producer report are different inputs
and receive different SHA-256 identities. The report is not embedded into the
artifact hash and is not accepted as evidence that the artifact contains,
performs, or verifies what the producer claims.

The case binding records, at minimum:

- `subjectHash`, calculated from the exact canonical decision subject;
- for an artifact, `artifactHash` from the exact bytes with media type
  additionally included in the subject identity;
- `producerReportHash` from a canonical sidecar when a report is present;
- the case and public-contract identity;
- the view condition, `raw` or `decision_review`;
- the Decision Packet hash when the `decision_review` condition is used; and
- the benchmark protocol and renderer identity.

The canonical encoding is part of this versioned implementation. A future
change to it must change the relevant protocol version and approved plan hash. A
sidecar change must never leave the case binding unchanged merely because the
artifact bytes did not change, and an artifact change must never inherit the
prior producer report without a new binding.

### Producer-report sidecar

The sidecar may contain bounded producer-authored fields such as summary,
reported checks, reported risks, confidence, and proposed next actions. These
remain `claimed`, including when their source is `runtime_compiled`. An
independent, hash-bound evidence source may separately verify the associated
criterion, but it never upgrades the producer claim itself to verified.

The implementation rejects a sidecar that is malformed, exceeds its bound, or
fails its declared schema. The sidecar has its own canonical identity and is
bound to the artifact through the Decision Packet; it is not repaired with an
extra model call during a measured review condition.

## Pure human-review view

The measured input to the reviewer is a bounded, human-readable review view.
It is produced by a pure renderer: the same bound inputs and renderer version
must produce the same review-view value and hash.

The renderer must not:

- call a model, network service, tool, clock, or mutable database;
- read the sealed oracle or hidden expected answer;
- discover files outside the supplied case bundle;
- infer verified evidence from producer prose; or
- vary content according to a previous reviewer call.

Both conditions use the same exact-subject preview policy and the same public
decision contract.

### Raw condition

The raw view presents the exact bounded subject preview. Artifact cases
present the artifact preview and any separately labelled producer-report
sidecar. The view does not add Decision Packet criterion results, evidence
classifications, or unresolved-exception projections.

### Decision-review condition

The `decision_review` view presents the same exact subject preview and any
producer report, plus the server-owned Decision Packet projection for that exact binding. The view
may include the decision question, criterion status, evidence provenance,
unresolved exceptions, and allowed decisions. It must not hide the artifact
or turn an unverified producer claim into verified evidence.

The two views will normally differ in input length. Calls and provider-reported
tokens and latency must therefore be shown beside quality results. This is not
a compute-matched comparison.

## Fixed paired suite

The first suite contains exactly ten versioned, fictional cases. Each case is
reviewed once in each condition:

```text
10 fixed cases x 2 views = 20 reviewer calls
```

The suite contains an explicit mixture of cases whose expected outcome is
approval, changes requested, rejection, or a request for user input. It also exercises useful
review boundaries such as missing evidence, failed evidence, a producer claim
that conflicts with the artifact, an incomplete acceptance criterion, and a
clean artifact whose evidence is sufficient. The committed suite manifest,
not the live reviewer, defines the final case selection.

Every case is paired: its exact subject, optional sidecar, public contract, and oracle are
identical between the raw and `decision_review` conditions. Only the
condition-specific review view changes. The twenty-call schedule is
deterministic, alternates AB/BA presentation order by case, and is committed
to the plan. Stateless isolation remains the primary carryover boundary.

## Stateless Codex reviewer

Every measured call starts a fresh ephemeral Codex review process in a new
temporary working directory. No conversation, operational workspace,
cacheable case text, or prior answer is intentionally shared between cases or
conditions.

The reviewer receives only:

- the condition-specific human-review view;
- the allowed decision enum; and
- the bounded structured response contract.

The reviewer does not receive the sealed oracle, oracle result, paired-view
answer, hidden case metadata, operational repository, Control Plane database,
credentials, environment values, or model output from another call.

The reviewer runs with read-only sandboxing, user configuration and rules
ignored, repository discovery skipped, and web, shell, apps, and multi-agent
features disabled. Its response is schema-constrained to one decision and
exactly two bounded review findings. Raw chain-of-thought is neither requested
nor stored.

The approved plan binds the reviewer executable digest, requested model,
isolation-protocol identity, timeout, output-byte bound, and response schema.
Provider token or cost usage that cannot be measured remains `null`, never
zero.

## Sealed deterministic oracle

Each case has a sealed oracle that the reviewer and review renderer cannot
read. The oracle may define:

- the acceptable decision or set of acceptable decisions;
- required finding codes and acceptable visible-reference bindings;
- critical error rules for unsafe or unsupported decisions; and
- deterministic scoring rules.

An LLM does not judge the measured LLM. Oracle evaluation occurs only after a
schema-valid reviewer response has been captured. The public report may expose
bounded result codes and aggregate scores, but not hidden oracle content that
would invalidate a later run.

An ordinary settled timeout, invalid response, or other scorable call failure
remains in the denominator. It must not disappear merely because no reviewer
answer was produced. A plan, executable, or provider-identity mismatch aborts
the benchmark. An executable-attestation failure or a child process that
cannot be proven terminated is a fatal containment error: no later call may
start, the checkpoint stays non-publishable, and the local lock is retained
for explicit recovery.

Quota or rate-capacity exhaustion and an authentication boundary are pause
conditions rather than scored reviewer failures after the child process has
settled. An operator signal is resumable only when observed between calls,
before the next flushed invocation record is created. Ctrl+C during an active
model call leaves that call's outcome unknown and fails closed. Before every
reviewer process starts, the runner writes and flushes its active invocation. A
checkpoint that is still `running`, is `failed`, retains an active invocation,
or cannot prove whether a call settled is not resumable and must never trigger
an automatic retry. Resume is allowed only from a clean `paused` checkpoint
with no active invocation.

## Measurements

The report preserves per-case outcomes and raw-minus-decision-review paired
comparisons. The product-regression measurements are:

- exact acceptable-decision rate;
- required-finding recall;
- correct decisions on the seven critical cases;
- reference-bound required findings;
- exact consequence selection and per-case pass count;
- schema-valid and command-protocol-valid response rates;
- calls, provider-reported input/output tokens, and client-observed latency;
- visible/prompt/response bytes, finish reason, and sanitized call failures;
  and
- critical-error, unsafe-approval, and unauthorized-tool-call counts.

The fixed packet-view gate requires ten accounted cases, all ten schema-valid
and command-protocol-valid responses, at least nine exact decisions, exact
decisions on all seven critical cases, at least 18 of 20 required findings, at
least 16 reference-bound findings, at least nine exact consequences, at least
eight complete per-case passes, zero critical errors, zero unsafe approvals,
and zero unauthorized tool calls. A benefit label also requires that the
packet arm does not regress schema/protocol validity, decisions, finding
binding, consequences, per-case passes, or safety relative to raw. These rules
are committed engineering gates, not statistical or human-benefit claims.
The CLI exit code reflects only the packet quality gate. JSON and human output
report `qualityGatePassed` and `benefitGatePassed` separately; a resumed run can
therefore exit successfully for packet quality while correctly refusing an
uninterrupted-benefit claim.

## Plan, approval, and execution

Planning is dry by default. It must make no reviewer call. A live run requires
the exact SHA-256 of the regenerated plan.

The implemented plan binds:

- the ten case IDs, suite hash, and sealed-oracle commitment;
- each public case hash, which transitively binds its artifact,
  producer-report, contract, and presentation inputs;
- the two view conditions and twenty-call schedule;
- renderer, packet, prompt, response-schema, evaluator, and exact local
  harness-source hashes;
- the reviewer executable hash, model, isolation policy, timeout, and output
  bound;
- the fixed call count, per-call timeout, requested output-token ceiling, and
  hard subprocess-output byte limit;
- report allowlist/privacy-policy version; and
- any declared product-regression thresholds.

Changing one of these values invalidates the previous approval. The live
runner also regenerates the complete plan, compares every field, and executes
only that regenerated immutable value; retaining an old `planHash` while
changing a schedule, threshold, protocol, or benchmark ID is rejected before
a reviewer process starts.

### Dry plan

```powershell
node bin/chartermesh.mjs evaluate-decision-review `
  --target <TARGET> `
  --suite decision-review-fixed-10-v1 `
  --codex-executable <ABSOLUTE_CODEX_EXECUTABLE> `
  --codex-sha256 <LOWERCASE_SHA256> `
  --codex-model <MODEL_ID> `
  --json
```

The dry response includes the complete plan and `planHash`, while
excluding local executable and target paths from the publishable plan.

### Live run

Repeat the exact plan-defining arguments and add live execution plus the exact
approved hash:

```powershell
node bin/chartermesh.mjs evaluate-decision-review `
  --target <TARGET> `
  --suite decision-review-fixed-10-v1 `
  --codex-executable <ABSOLUTE_CODEX_EXECUTABLE> `
  --codex-sha256 <LOWERCASE_SHA256> `
  --codex-model <MODEL_ID> `
  --live `
  --approve <PLAN_HASH> `
  --json
```

The implementation fails before the first reviewer call when the plan, suite,
model binding, executable attestation, or approval hash differs. Timeout and
output-byte options default to 120,000 ms and 1,048,576 bytes; changing either
changes the plan hash. Run `evaluate-decision-review --help` for the complete
current command surface.

### Pause and exact resume approval

The local checkpoint lives at
`.chartermesh/evaluations/<benchmarkId>/checkpoint.json`. It commits the exact
base plan, completed trials as a contiguous immutable schedule prefix, a hash
of that prefix, invocation state, and bounded execution-segment metadata. It
is operational state and is never a public result. A completed report is the
only object written under `.chartermesh/exports/`.

After a clean pause, generate a no-inference resume plan by repeating the base
plan arguments and adding `--resume` plus an account-context declaration:

```powershell
node bin/chartermesh.mjs evaluate-decision-review `
  --target <TARGET> `
  --suite decision-review-fixed-10-v1 `
  --codex-executable <ABSOLUTE_CODEX_EXECUTABLE> `
  --codex-sha256 <LOWERCASE_SHA256> `
  --codex-model <MODEL_ID> `
  --resume `
  --account-context <same|changed|unknown> `
  --json
```

The resume plan binds the base plan hash, exact checkpoint hash, immutable
completed-prefix hash, next sequence, remaining schedule, next anonymous
execution segment, and the operator's account-context declaration. It also
revalidates the same suite, protocol, requested model, executable digest,
isolation policy, time/output limits, and exact harness-source digest. The
local path is supplied again for execution but is deliberately not published
or treated as an account identifier.
It performs no reviewer call and does not modify the checkpoint.

Review that new plan, then repeat the exact command with live execution and its
new hash:

```powershell
node bin/chartermesh.mjs evaluate-decision-review `
  --target <TARGET> `
  --suite decision-review-fixed-10-v1 `
  --codex-executable <ABSOLUTE_CODEX_EXECUTABLE> `
  --codex-sha256 <LOWERCASE_SHA256> `
  --codex-model <MODEL_ID> `
  --resume `
  --account-context <same|changed|unknown> `
  --live `
  --approve <RESUME_PLAN_HASH> `
  --json
```

Every resume segment requires a fresh exact approval. After acquiring the
run lock, live mode rereads the checkpoint and regenerates the resume plan; a
changed checkpoint, source tree, executable, model, limit, protocol, or
schedule invalidates the approval before another reviewer process starts. An
old base or resume plan hash is therefore unusable after benchmark-source
changes.

The resume transition appends a segment that binds the exact source-checkpoint
hash, prior-segment-chain hash, process-attempt count, and resume-plan hash. It
also creates an exclusive local used-approval receipt before any new model
process starts. A dead-owner stale lock is recovered only for the exact
approved `paused` checkpoint with no active invocation; running, failed, or
ambiguous state stays locked and non-resumable. State files reject symlink or
junction components, bounded JSON is read through one checked file handle, and
checkpoint replacement flushes the temporary file before atomic rename.

CharterMesh does not inspect or persist the Codex account identity. It stores
no account label, email, authentication-home path, credential value, or
credential hash. `same`, `changed`, and `unknown` are operator-declared and
unverified context. Every resume is a temporal execution discontinuity, so even
`same` prevents a strict uninterrupted single-reviewer benefit claim. A
`changed` or `unknown` segment additionally discloses account-continuity
uncertainty while remaining useful for a resilience/regression run.

These hashes and receipts provide single-user local audit integrity, not a
digital signature or protection against a malicious concurrent local writer,
storage rollback, or replacement of the whole state directory. Directory
flush after rename is best-effort on filesystems that expose it. The final
report publishes its completed-prefix hash, segment-chain head, and a hash of
the allowlisted report body so ordinary accidental restoration or tampering is
detectable.

## Publishable report and privacy

The final report is an allowlist projection, not a redacted copy of runtime
state. It may contain:

- report, suite, plan, protocol, renderer, and evaluator identities or hashes;
- the requested reviewer binding and bounded provider-reported identity without
  local paths;
- case IDs, condition IDs, subject and view-binding hashes;
- structured reviewer decisions, bounded finding codes, and only reference IDs
  that occur in the selected fixed public view; invalid model-supplied IDs are
  reduced to a count and hash;
- sealed-oracle pass/fail results and aggregate paired deltas;
- calls, nullable usage and cost, latency, finish reason, and sanitized error
  codes;
- critical-error, unsafe-approval, and unauthorized-tool-call counters; and
- explicit interpretation boundaries; and
- the final completed-prefix, segment-chain, and report-body hashes.

It must not contain:

- artifact or producer-report content;
- rendered view text, reviewer prompt, raw response, chain-of-thought, stdout,
  or stderr;
- sealed oracle content or hidden expected answers;
- absolute target, executable, database, artifact, temporary, or home paths;
- host name, user name, process ID, environment values, credentials, tokens,
  endpoints containing credentials, or secret-like fields; or
- raw exception messages or arbitrary nested provider payloads.

Unknown fields are dropped instead of recursively copied and then redacted.
Before the final report is returned, the implementation walks the allowlist
projection and rejects raw payload keys, Windows drive paths, UNC paths,
common POSIX system/home paths, file URLs, and common credential forms. The
operator should still inspect the completed file before publication. Hash
fields such as `promptHash` are commitments, not prompt disclosure.

Only a completed final report is publishable. A running, paused, or failed
checkpoint, evaluation database, lock, temporary directory, or abandoned run
remains local even if it has a `.json` extension. The final report should be
linked from a human-readable case-study Markdown file that states the exact
source revision, account-context limitations, design limits, results, and
non-claims.

## Dashboard boundary

Dashboard display is not required to execute or publish this benchmark. The
first reference should use a static Markdown result table and the allowlisted
JSON report.

If a dashboard view is added later, it should import an explicitly selected,
completed report through a strict read-only schema. It must not mix synthetic
review-proxy results into operational human-decision counts or make the
benchmark database a second writable WorkItem ledger. A compact view should
show quality, reliability, resource, and safety/protocol summaries together
with the interpretation boundary.

## Minimum publication checklist

- Exact source revision and benchmark protocol are named.
- The public JSON hash matches the case-study Markdown.
- The approved plan hash and suite hash match the report.
- Exactly ten paired cases and twenty reviewer calls are accounted for,
  including failures.
- Raw and `decision_review` results are shown with calls, tokens, and time.
- Unknown usage remains `null`.
- Every resume segment has an exact approved resume-plan hash, and the report
  discloses operator-declared account-context changes or uncertainty.
- No production human approval is claimed or recorded.
- The report has only allowlisted fields and passes the publication path/secret
  inspection.
- Running, paused, failed, abandoned, and local database artifacts are
  excluded.
- The conclusion is limited to a descriptive product regression.
