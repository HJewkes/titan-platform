# Guides

## Understanding the platform

- **[Capability catalog](/guides/capabilities)** — generated. Every package, product and
  app with a "use this when" line and key exports, the proven runtime paths and their
  credentials, and the known gaps. The first stop before you build anything.

- **[Architecture](/guides/architecture)** — the tiers, the real dependency graph, why the
  DAG is enforced by CI, and the two time models `store-sqlite` offers.
- **[The binding pattern](/guides/binding-pattern)** — how a product fixes a package's type
  parameters in one module so every call site stays unchanged. The single idea most worth
  reading before you adopt anything.

- **[Where code goes](/guides/where-code-goes)** — mechanism in packages, pixels in
  titan-design, policy in products; how a product's own npm scope shrinks as its engine is
  ported; and what a port pull request must prove.

- **[Package families](/guides/package-families)** — the packages grouped by the job they
  share (storage, command surfaces, the front-end kit, agent execution, landing a change,
  session mining, code audit, messaging), with a line and a link for each.

- **[Multi-harness contracts](/guides/multi-harness-contracts)** — the additive Claude/Codex
  contracts and the compatibility migration required before mixed-session ingestion.

## Running the products

One guide per runnable unit. Each covers what the unit is for, prerequisites, the build,
every command with an invocation, where state and logs live, and how it fails.

- **[Factory](/guides/factory)** — `titan-factory`: `serve` on loopback port 7410 with
  `/health`, `/rpc` and `/mcp`, `land`, `gate resolve`, `resume`, the launchd service, and
  the config file.
- **[Shepherd](/guides/shepherd)** — the factory's PR watcher end to end: register a pull
  request or a branch, phases, seat policy, hold and release, the merge evaluation, the
  MRG-AU-RV authority row, and what is not built yet.
- **[Set up the autonomous loop](/guides/autonomous-loop-setup)** — what to create to run
  the build-and-merge loop: the release GitHub App, npm trusted publishing, rulesets, the
  factory service, seat policy and Claude Code grants.
- **[Session miner](/guides/session-miner#run-it)** — `titan-miner`: index Claude Code and
  Codex transcripts, search, cluster failures, keep a playbook, serve over MCP and HTTP.
- **[Retrieval eval](/guides/retrieval-eval)** — `retrieval-eval`: mine query and label
  pairs from transcripts and score candidate retrievers.
- **[Code report](/guides/codewatch)** — `apps/codewatch`: index a repo, browse the
  report live, or export one HTML file.
- **[Matrix hub](/guides/hub)** — `deploy/hub`: the Tuwunel and Caddy compose stack the
  human queue runs on.

## End-to-end stories

- **[Case study: the session miner](/guides/session-miner)** — <!-- generated:miner-count start -->twelve<!-- generated:miner-count end --> packages composed into
  one product. Follows a refresh and a search through the DAG, with real output.
- **[Case study: adopting registry and daemon](/guides/adopting-a-package)** — active-work
  replacing two hand-written modules with packages: about a thousand lines deleted, 1,321
  tests unchanged, and the two regressions that nearly slipped through.

## Working here

- **[Working in the repo](/guides/contributing)** — the scaffold, the DAG check, changesets,
  and how a release happens.
