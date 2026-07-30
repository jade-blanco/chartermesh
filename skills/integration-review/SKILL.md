---
name: integration-review
description: Evaluate an external skill, MCP server, model adapter, or local tool before installation using source, license, permission, privacy, and reproducibility evidence.
license: Apache-2.0
compatibility: Works read-only until a human approves an exact installation or configuration plan.
metadata:
  author: CharterMesh contributors
  version: 1.0.0
---

# Integration review

External agent extensions are executable supply-chain inputs.

## Review gate

1. Confirm the canonical source and current maintainer.
2. Record the license and whether vendoring, modification, and redistribution
   are permitted.
3. Inventory filesystem, process, network, credential, browser, and external
   service access.
4. Prefer an existing CharterMesh built-in when it provides the same
   capability with a narrower permission boundary.
5. Pin a reviewed version and integrity identifier where the distribution
   mechanism supports it.
6. Require an exact human-approved plan before installation or configuration.
7. Start disabled, scope paths and credentials narrowly, and run a synthetic
   test before project data is exposed.
8. Document removal, update, and incident-response steps.

Popularity, stars, a registry listing, or the label "official" does not replace
threat-model review.
