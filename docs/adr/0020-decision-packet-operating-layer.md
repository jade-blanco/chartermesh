# ADR 0020: Decision Packet operating layer and separated attention queues

- Status: accepted
- Date: 2026-08-02

## Context

The action-centric dashboard made blocked work and exact approvals visible, but
it still mixed human decisions with role actions. It also let the browser turn
raw `StructuredArtifact` fields into a review summary. A model-authored
`checks` string was presented as automatic verification even though it did not
prove a tool or validator ran. This reduced clicks without reducing the harder
human bottleneck: understanding what was produced, why it should be trusted,
what remains unknown, and what each decision will do.

CharterMesh is therefore defined first as an operating layer that compresses
multi-agent complexity into one verifiable human decision. Autonomous-company
claims are out of scope until sealed reliability and safety gates support them.

## Decision

The Control Plane creates a provider-neutral
`chartermesh.dev/decision-packet/v1alpha1` projection for each active artifact
review, exact tool execution approval, and user-input request. Packet creation
does not call a model.

The packet binds:

- the WorkItem decision contract and decision question;
- the exact artifact, tool-call, or input-request subject hash;
- runtime and validator evidence with explicit provenance and status;
- producer-reported checks as `model_reported/claimed` only;
- criterion results and unresolved exceptions; and
- the WorkItem version and projection version.

The canonical packet hash excludes presentation strings and timestamps but
includes contract, subject, evidence-set, criterion-result, and exception
identity. Artifact and tool decisions require both the subject hash and current
packet hash. Artifact review now enforces a `human:*` actor exactly as tool
approval already did. A new packet supersedes the prior packet and prior
artifact approval.

The dashboard consumes the server packet. It displays one global primary human
decision, then separate human, role, waiting, and history queues. Failed work is
history, not a current human obligation. `changes_requested` is role rework.
Approval of a deliverable can close that artifact-only WorkItem in the same UI
decision, but it never authorizes a separate write, deployment, network call,
publication, or other side effect.

User-input waits cannot be cleared by generic resume. A human supplies the
response against the current packet hash; the Control Plane stores it and the
next runner receives the exact response and its hash.

The dashboard may record bounded active-review duration and technical-detail
open count as local estimated UX observations. It must not infer correctness or
quality from normal operating data. Those claims require a separate blinded
human-comprehension study with a sealed oracle.

The local CharterMesh host process and Control Plane database are inside the
trusted computing boundary. Model engines, model output, and provider adapters
never receive the receipt preparation token or the runtime capability. A
threat model that treats the installed host itself as malicious requires a
separate Tool Runtime process with authenticated IPC and is not claimed by
this in-process vertical slice.

## Invariants

1. `model_reported` evidence is never `verified`.
2. A criterion is automatically satisfied only when all declared evidence
   requirements have verified evidence from the current run. v1alpha1
   implements Tool Runtime ingestion; `host_validator` remains reserved until
   a hash-bound ingestion path exists.
3. Tool Runtime evidence is verified only after the Control Plane's exact
   pre-execution intent receipt and the in-process Tool Runtime's
   non-serializable post-execution capability both match. Actor-name prefixes
   and legacy rows are not provenance authority.
4. Missing or subjective evidence remains `unverified`, never zero or success.
5. The browser cannot invent packet fields or evidence status.
6. Only `human:*` actors may submit a human decision.
7. A stale packet hash fails even when the subject hash is unchanged.
8. Artifact approval never grants external execution authority.
9. The SQLite Control Plane remains the only mutable task and decision ledger.
10. Human-decision priority is global and independent of the newest-work page.
11. Failed work and completed review feedback remain inspectable history.

## Consequences

- Review is more honest: concise producer summaries remain useful, while their
  claims are visibly distinct from execution evidence.
- A human approves the exact decision context, not only a file hash.
- Role work no longer inflates the number presented as “my decisions.”
- Old human decisions cannot disappear merely because many newer WorkItems
  exist.
- Existing databases migrate to schema version 11 with a safety backup. Legacy
  tool evidence without a consumed runtime receipt is not trusted. Legacy
  WorkItems receive an in-memory derived contract when no stored contract
  exists; their subjective criteria remain unverified.
- `exception_only` review remains a future policy. The current default is
  `human_required`; no model or deterministic validator is recorded as a human
  approval.
