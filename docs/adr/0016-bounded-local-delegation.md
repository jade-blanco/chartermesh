# ADR 0016: Bounded local delegation is a ManagedRunner capability

- Status: accepted
- Date: 2026-07-31

## Context

CharterMesh separates arbitrary `ModelEngine` inference from optional external
`AgentHost` products. The OrgSpec can express delegated work, but the built-in
runner previously executed only one worker. That meant local Gemma and other
small models could not be tested under the same explicit multi-role structure
without depending on Codex, Claude, Gemini, or a provider-native team API.

Treating four model prompts as if they were host-native agents would be
misleading. Running them without durable lineage would also bypass the Control
Plane's usage, cancellation, recovery, and audit boundaries.

## Decision

Add an experimental provider-neutral `DelegationController` above the
`ManagedRunner` and below the CLI workflow:

```text
parent Run / primary Attempt
  ├─ planner child Attempt
  ├─ implementer child Attempt
  ├─ verifier child Attempt
  └─ synthesizer child Attempt → one human-reviewed artifact
```

The first implementation has fixed limits:

- depth 1;
- exactly four bounded roles;
- sequential execution;
- parent-only handoffs;
- one writer/tool-capable implementer;
- one existing structured-output repair turn per role;
- no peer team, child-to-child messaging, or automatic nested delegation.

Each child Attempt is created in the Control Plane before its model invocation.
Every invocation is closed as succeeded, failed, canceled, or abandoned. Parent
lease recovery abandons all running child invocations in the Run. A canceled
Run becomes `canceled`, not `failed`. Human tool approval and final artifact
approval remain unchanged and cannot be satisfied by any child model.

The capability is named `orchestration.delegated` and reported as emulated and
experimental. It does not satisfy or impersonate `host.delegate.subagent`.
Future Codex, Claude, or other AgentHost adapters must project their native
children into the same durable parent/child ledger.

## Evaluation

`evaluate-collaboration` compares single and delegated execution on paired
fictional tasks. The conditions share an 8192 maximum requested output-token
ceiling including repair turns. Reports call this
`generation-budget-ceiling-matched`; they do not claim equal total tokens
because the current engine contract has no mandatory pre-call tokenizer.

Observed input/output/cost values remain measured, estimated, or unknown
according to the engine response. Synthetic scoring is a compatibility smoke
test, not proof of production coding quality.

## Consequences

- Any compatible local or remote ModelEngine can run the bounded experiment.
- Child roles have auditable lineage and usage without becoming a second task
  ledger.
- Small-model collaboration overhead and correlated errors are visible.
- Crash-resumable independent child WorkItems, join barriers, parallel
  isolation, and native AgentHost event projection remain future work.
