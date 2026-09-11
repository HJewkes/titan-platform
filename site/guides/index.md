# Guides

## Understanding the platform

- **[Architecture](/guides/architecture)** — the tiers, the real dependency graph, why the
  DAG is enforced by CI, and the two time models `store-sqlite` offers.
- **[The binding pattern](/guides/binding-pattern)** — how a product fixes a package's type
  parameters in one module so every call site stays unchanged. The single idea most worth
  reading before you adopt anything.

- **[Multi-harness contracts](/guides/multi-harness-contracts)** — the additive Claude/Codex
  contracts and the compatibility migration required before mixed-session ingestion.

## End-to-end stories

- **[Case study: the session miner](/guides/session-miner)** — ten packages composed into
  one product. Follows a refresh and a search through the DAG, with real output.
- **[Case study: adopting registry and daemon](/guides/adopting-a-package)** — active-work
  replacing two hand-written modules with packages: about a thousand lines deleted, 1,321
  tests unchanged, and the two regressions that nearly slipped through.

## Working here

- **[Working in the repo](/guides/contributing)** — the scaffold, the DAG check, changesets,
  and how a release happens.
