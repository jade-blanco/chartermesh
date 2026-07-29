# Contributing

Contributions are welcome for bounded, provider-neutral improvements.

1. Read `docs/PRODUCT-DESIGN.md` and the relevant ADRs.
2. Keep provider-specific behavior behind capability manifests and adapters.
3. Add or update traceability entries for product requirements.
4. Add offline regression tests for every state or policy change.
5. Run `pnpm verify`.
6. Do not add generated secrets, private datasets, user paths, or real provider
   credentials.

Before opening a pull request:

- keep the change focused and explain any architecture boundary it changes;
- update an ADR when changing a recorded decision;
- add offline tests;
- run `pnpm verify`;
- confirm no credentials, private data, absolute user paths, or provider
  account details are present.

Package publication, deployments, paid model calls, and cloud-resource creation
are maintainer actions and are not implied by accepting a contribution.
