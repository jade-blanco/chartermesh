---
name: tool-grounded-implementation
description: Make bounded code changes with small or local models by requiring repository inspection, exact approved writes, read-back evidence, and an honest structured artifact.
license: Apache-2.0
compatibility: Provider-neutral; requires only CharterMesh workspace tools and the Control Plane approval flow.
metadata:
  author: CharterMesh contributors
  version: 1.0.0
---

# Tool-grounded implementation

Use this procedure when a WorkItem requires a workspace tool.

## Execution order

1. Inspect the named requirements and tests with the available read tools.
2. Keep the requested change bounded to the named files.
3. Call every tool listed under `Required execution evidence`.
4. For `workspace.write_file`, provide complete valid JSON with exactly the
   requested relative path and the entire final UTF-8 file content.
5. A pause for exact-call human approval is expected. Do not replace the tool
   call with a prose implementation or a claimed completion.
6. After an approved call is replayed, read the changed file when a read tool is
   available and compare it with the requirements before returning the final
   artifact.
7. Put only successful tool-backed actions in `checks`. Put tests that could not
   run in `nextActions`.

## Small-model constraints

- Prefer concise source without tutorial comments so the tool arguments remain
  within the output budget.
- Do not emit partial files, ellipses, placeholders, Markdown fences, or
  unescaped JSON.
- If a required tool cannot succeed, return a low-confidence blocked result;
  never claim the requested side effect happened.
