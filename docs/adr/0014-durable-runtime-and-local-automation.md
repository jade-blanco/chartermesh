# ADR 0014: Durable runtime control and opt-in local automation

- Status: accepted
- Date: 2026-07-30

## Context

The runtime schema existed, but consumers treated parsed JSON as a TypeScript
type. A malformed hand edit could therefore fail during adapter execution.
Model invocation evidence was also written only after a call returned, leaving
a process-death window where the provider or local model had started but no
usage record existed.

Long-running installations need bounded reads and delivery retry, while local
scheduling must not introduce a daemon, a paid call, or an empty-queue model
start by default.

## Decision

### Runtime validation

The dependency-free JSON Schema evaluator is reusable for OrgSpec and runtime
configuration. Every runtime consumer parses
`schemas/runtime-config-v1alpha1.schema.json` before adapter construction.
Semantic validation enforces unique engine and runner ids and valid
`modelEngineRef` values.

### Invocation and cancellation lifecycle

The Control Plane writes a `running` invocation before handing the request to a
ModelEngine. The runner closes it as `succeeded`, `failed`, or `canceled`.
Expired-lease recovery closes remaining running invocations as `abandoned`.
Unknown token counts and cost remain null.

Cancellation is a persistent Run command. A foreground signal, dashboard
action, or separate CLI requests cancellation through that command. The active
runner polls durable state and propagates one `AbortSignal` to the engine.

### Bounded state access

WorkItems have a stable cursor page API. Archive is a human-only timestamp on
terminal WorkItems, not deletion. The default list hides archived work while
an explicit option includes it. Audit export pages the allowlisted projection
and writes JSONL incrementally.

### Outbox delivery

An outbox delivery is claimed by one owner with stale-claim recovery. Success
is acknowledged; failure increments attempts and applies bounded exponential
backoff. Exhausted delivery is dead-lettered. Only a human command can requeue
a dead letter. The core supplies the dispatcher loop but no network handler or
background process.

### Local scheduler

Default OrgSpec proposals contain no schedules. The first controller supports
only `MINUTELY`, `HOURLY`, and `DAILY` intervals with an integer `INTERVAL`.
Ticks have deterministic unique keys, record overlap/no-work outcomes, and
check the Control Plane for claimable work before invoking a model.
`scheduler watch` is an explicit foreground process; CharterMesh does not
install it as an operating-system service.

## Consequences

- Bad runtime edits fail in `doctor` and before any model call.
- Started-but-interrupted calls remain visible with conservative unknown cost.
- Cancellation survives client separation and uses the same ledger authority.
- Archived work and large audit histories remain inspectable without deleting
  evidence or requiring an all-record in-memory projection.
- External integrations can be reliable without being enabled automatically.
- Local scheduling costs nothing when disabled and starts no model on an empty
  queue.
- Full RFC 5545 recurrence, missed-run policy, service installation,
  provider-native scheduling, and attempt-level retry queues remain future
  decisions.

## Verification

- Runtime parser unit tests and CLI E2E cover unknown fields and dangling
  references.
- Control Plane and CLI E2E cover invocation lifecycle and cross-process
  cancellation.
- Pagination/archive and outbox retry/dead-letter have Control Plane tests.
- Scheduler unit and CLI E2E prove disabled defaults, interval gating, durable
  ticks, and zero invocations on an empty queue.
