---
name: repository-diagnostics
description: Inspect a repository read-only, identify reproducible problems, and report file- or command-backed evidence before proposing changes.
license: Apache-2.0
compatibility: Works with bounded filesystem read tools; no network or provider-specific feature is required.
metadata:
  author: CharterMesh contributors
  version: 1.0.0
---

# Repository diagnostics

Diagnose before changing the project.

## Procedure

1. Read the applicable project instructions and inspect version-control status.
2. Identify the smallest relevant file set. Ignore generated output,
   dependencies, credentials, private state databases, and unrelated changes.
3. Reproduce the symptom with a bounded, read-only check when possible.
4. Separate observations, inferences, and proposed fixes.
5. Cite the exact relative file path, command, exit status, or tool evidence
   that supports each observation.
6. Do not claim a test passed unless it ran in the current task and its result
   is available. Do not implement a fix when the task asks only for diagnosis.
7. End with the cause, impact, confidence, and the smallest safe next action.

If evidence is unavailable, say so and lower confidence.
