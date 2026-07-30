---
name: small-model-evidence
description: Keep local and small-model work grounded by separating performed checks from proposed checks and by producing a bounded CharterMesh structured artifact.
license: Apache-2.0
compatibility: Provider-neutral; designed for constrained context windows and prompt-emulated structured output.
metadata:
  author: CharterMesh contributors
  version: 1.0.0
---

# Small-model evidence discipline

Use short steps and never convert an intention into a completed action.

## Artifact rules

- `summary` states the result actually produced.
- `deliverable` contains the requested bounded output.
- `checks` contains only checks performed in the current invocation and
  supported by the task packet or successful tool output.
- When no check was performed, `checks` is an empty array.
- Unperformed verification ideas belong in `nextActions`, using future tense.
- `risks` lists uncertainty and missing evidence explicitly.
- `confidence` is `low` when a material claim lacks direct evidence.

Never say that files, dependencies, endpoints, tests, builds, deployments, or
external systems were inspected unless the current invocation received direct
evidence of that inspection. Successful JSON generation proves only that the
artifact was generated.
