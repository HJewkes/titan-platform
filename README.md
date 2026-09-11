# titan-platform

Reusable `@titan-design/*` packages arranged as a strict acyclic DAG, plus the products
composed thinly on top of them. This is the destination monorepo for the Titan platform
decomposition: shared concerns that grew independently in brain, active-work, codewatch,
and the session-miner get extracted here one package at a time, and each old repo keeps
running on the published packages until its capability is rebuilt here.

**Documentation: <https://hjewkes.github.io/titan-platform/>** — what each package does,
when to reach for it, worked examples, the architecture, and the case studies.

## Layout

```
packages/     the shared tiers (published to npm as @titan-design/<name>)
products/     apps composed from the tiers (private)
templates/    the uniform per-package scaffold that scripts/new-package.mjs stamps
scripts/      new-package.mjs, dag-check.sh, gen-docs-reference.mjs
site/         the documentation site (VitePress)
.codewatch/   check.json: the DAG and fitness rules codewatch enforces
```

## The DAG

A package may import only packages in its own tier or a lower one. Never sideways across a
higher tier, never upward.

| Tier | Packages | Role |
|---|---|---|
| 0 | store-sqlite, locator, cluster, embed, agent-protocol | primitives and shared wire contracts |
| 1 | retrieval, agent, agent-lifecycle, registry, daemon, hitl | engines |
| 2 | session-read, session-graph, code-graph, memory, workflow | domain modules |
| ui | ui | generic dashboard kit |
| product | products/* | thin compositions |

`.codewatch/check.json` is the source of truth. Its `package-layers` rule lists every
package by tier, and CI fails any pull request that adds an import against the order.

## Working here

```
pnpm install && pnpm build && pnpm typecheck && pnpm lint && pnpm test && pnpm dag:check
```

All six must be green before you finish a change. `dag:check` needs codewatch built at
`~/projects/codewatch/packages/cli/dist/index.js`, or set `CODEWATCH_CLI`.

Adding a package, running the DAG check against a base ref, the changeset requirement, the
release flow, and the docs-site scripts are all documented in
[Working in the repo](https://hjewkes.github.io/titan-platform/guides/contributing).
