# ADR 0007: Apache-2.0 license and CharterMesh name

- Status: accepted
- Date: 2026-07-27
- Updated: 2026-07-29

## Considered licenses

- Apache-2.0: recommended for adoption, integrations, and commercial use while
  retaining patent protections.
- AGPL-3.0: consider when requiring hosted modifications to remain available is
  more important than adoption friction.

## Decision

Use Apache-2.0 for the repository and packages. The standard license text is
stored at the repository root as `LICENSE`.

The public project name is **CharterMesh**. “Charter” conveys the approved
organization and policy contract; “Mesh” conveys interchangeable model engines,
managed runners, and external agent hosts.

An exact-name web search found no meaningful software-project collision before
the first source publication. Search absence is not trademark clearance. A
maintainer must still perform appropriate registry and legal checks before a
commercial launch or package-registry publication.

## Considered names

1. **CharterMesh** — accepted.
2. **Synnomy** — more distinctive as a brand, but spelling and pronunciation
   require explanation.
3. **Orbispec** — strongest developer-tool tone, but less immediately connected
   to agent organizations.

Avoid the former `AgentOrg` working direction: an
[active AI-agent organization product](https://www.agentorg.run/) already uses
that name. Repeat repository, package registry, domain, and legal searches
after the user chooses a candidate.
