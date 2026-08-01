# ADR 0018: Sealed code evaluation and VM sandbox

- Status: accepted
- Date: 2026-07-31

## Context

The existing execution evaluator applies bounded JSON configuration edits but
deliberately never executes model-generated source. Comparing a small local
model with a tiered reviewer configuration requires a stronger functional
signal without turning the contributor workstation into the test sandbox.
WSL file and process isolation is configurable, but a normal WSL distribution
is not treated as a hostile-code security boundary.

## Decision

CharterMesh adds an opt-in code-maintenance pilot with these boundaries:

- The development suite contains six deterministic, dependency-free Node.js
  maintenance tickets across three fictional repositories. The model sees the
  ticket, repository files, and two public examples. It does not receive the
  hidden cases, oracle, mutations, or their results. The development suite is
  committed as open-source test data; "sealed" means withheld from inference
  during a run, not secret or unpublished.
- Before generated code is evaluated, the harness proves that every oracle
  passes, every declared baseline defect is detected, and at least 95% of the
  seeded mutations are killed. The current pilot commits three mutations per
  task.
- Generated source executes only through a backend whose manifest says `vm`,
  whose network is disabled, and whose live canary proves host read/write,
  child-process, timeout, and output-allowlist controls. There is no fallback
  to host Node, WSL, or a simulated backend.
- The initial backend is Windows Sandbox with networking, vGPU, clipboard,
  audio, video, and printers disabled and Protected Client enabled. Input and
  the Node runtime are read-only mappings. A disposable result directory is
  the only writable host mapping.
- The candidate runs in a secretless worker process. A separate supervisor
  owns the HMAC secret and frames the result. This protects result framing; it
  is not claimed as an isolation boundary against another process running as
  the same OS user.
- The untrusted candidate process may read only its fixed executor and its own
  repository fixture. It receives each case on standard input, cannot write
  files or start subprocesses, and never receives expected hidden outputs.
- Candidate generation and hidden execution are separate phases. All model
  stages and engine fingerprints finish before the state is atomically frozen.
  Hidden tests run only from that frozen state, and their results are never
  supplied to a later model.
- Publishable generation starts only from a clean source checkout with a known
  Git commit. Before any state read or model call, the harness binds package,
  Git, Node/runtime hash, OS build, and canonical sandbox guest-bundle
  provenance. Every later stage must reproduce that exact commitment.
- Four paired conditions use the same 6,144 requested-output-token ceiling per
  task: E4B single, 26B single, Qwen single, and E4B draft to 26B review to
  Qwen final review. Singles receive one 6,144-token call; the tiered condition
  receives three 2,048-token calls. There are no repair retries. Input-token
  use and latency are reported because the tiered condition necessarily uses
  more of both.
- Every engine requires a file or canonical shard-manifest hash. Adapter,
  context limit, structured-output mode, reasoning mode, temperature, and
  sampling seed, timeout, and maximum response bytes must be identical across
  slots before freeze. Server-stack differences remain visible in the engine
  descriptors.
- Raw candidates live only in the ignored local evaluation state. Public
  reports retain hashes, aggregate case counts, contract status, usage,
  latency, and policy evidence.
- Publishable generation starts only from a clean Git commit and binds the
  harness, Node runtime, OS, and canonical guest bundle before inference.
  Every VM stages those files through verified handles and rechecks the staged
  hashes before start and after stop.
- Windows may expose trusted workspace ancestors through directory junctions,
  including on GitHub-hosted runners. Launcher and session-journal operations
  resolve such ancestors once and bind the canonical target by file or
  directory identity for the ensuing operation. A link at the launcher or
  journal entry, a redirected immediate journal parent, identity drift, or a
  digest mismatch still fails closed. Journal removal is always a verified,
  non-recursive unlink.

## Consequences

The harness fails closed on machines without a verified backend. Windows
Sandbox requires a supported Windows edition, optional-feature activation,
and possibly a restart. This is an explicit operator setup step, not an
automatic package installation.

An installed package lacks source-checkout Git provenance and is therefore
non-publishable for this pilot. Supporting publishable installed-package runs
requires a future signed package-artifact attestation rather than silently
treating missing Git metadata as clean.

Each generated candidate receives a separate disposable VM session. Cases for
that one candidate may share the session, but candidates cannot influence one
another. A candidate can still crash or disrupt its own disposable session;
this becomes a failed evaluation, not a result that another candidate can
observe.

The six-task suite is a development pilot. It can compare the tested
configurations on the declared task families, but it cannot support a general
autonomous-company claim. A release claim still requires a separately frozen
private holdout, larger samples, repeated cold runs, and the statistical gates
documented in the evaluation plan.

The tiered condition is serial model review routing. It is not evidence that
the Control Plane can create, join, cancel, or permission-bound child agents.

Future Linux, macOS, and container backends must satisfy the same manifest and
live-canary contract. Merely matching the interface is insufficient.
