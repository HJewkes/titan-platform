# titan-platform

Reusable `@titan-design/*` packages arranged as a strict acyclic DAG, plus the products
composed thinly on top of them. This is the destination monorepo for the Titan platform
decomposition: shared concerns that grew independently in brain, active-work, codewatch,
and the session-miner get extracted here one package at a time, and each old repo keeps
running on the published packages until its capability is rebuilt here.

## Layout

```
packages/     the shared tiers (published to npm as @titan-design/<name>)
products/     apps composed from the tiers (private)
templates/    the uniform per-package scaffold that scripts/new-package.mjs stamps
scripts/      new-package.mjs, dag-check.sh
.codewatch/   check.json: the DAG and fitness rules codewatch enforces
```

## The DAG

A package may import only packages in its own tier or a lower one. Never sideways across
a higher tier, never upward.

| Tier | Packages | Role |
|---|---|---|
| 0 | store-sqlite, locator, cluster, embed | domain-free primitives |
| 1 | retrieval, agent, registry, daemon, hitl | engines |
| 2 | session-read, session-graph, code-graph, memory, pm, workflow | domain modules |
| ui | ui | generic dashboard kit |
| product | products/* | thin compositions |

`.codewatch/check.json` is the source of truth. Its `package-layers` rule lists every
package by tier, and CI fails any pull request that adds an import against the order.

## Conventions

- pnpm workspace. Root scripts fan out with `pnpm -r run <script>`; no task runner.
- One shared `tsconfig.base.json` (ES2022, NodeNext, strict, `verbatimModuleSyntax`).
- Every package has the same shape: ESM-only tsup build, `tsc --noEmit` typecheck,
  `eslint src` lint, `exports` with `types` first. Copy nothing by hand; stamp it.
- Tests live next to source as `*.test.ts` and run from the root with vitest.
- Versioning is independent per package via changesets (no fixed group). Add a changeset
  in the same PR as the change.
- Every CLI surface a package exposes takes `--json` and returns the JSON envelope.

## Adding a package

```
pnpm new:package <name> --tier <0|1|2|ui|product> --description "..." --task TP-n
```

This copies `templates/package`, fills in the name and tier, and registers the package in
`.codewatch/check.json` under its tier. Then `pnpm install` to link it.

## Checking the DAG locally

codewatch is not on npm yet, so the check runs against a built checkout:

```
CODEWATCH_CLI=~/projects/codewatch/packages/cli/dist/index.js pnpm dag:check
```

The default path is exactly that, so a plain `pnpm dag:check` works on a machine with
codewatch built next to this repo. Set `BASE_REF=origin/main` to only report violations
that are new relative to main, which is what CI does.

## Releasing

CI on a pull request fails if a package changed without a changeset (`pnpm changeset`).
On every merge to main, the Release workflow either updates the "Version Packages" pull
request from pending changesets or, once that PR is merged, publishes the bumped packages
to npm. Publishing uses npm trusted publishing (OIDC), so there is no token secret: each
package has a trusted publisher on npmjs.com pointing at `HJewkes/titan-platform` and
`release.yml`. A package's first publish must happen before that publisher can be
configured, so bootstrap new packages once by hand with `pnpm release` from a logged-in
shell.

A red `lint`, `typecheck`, or `test` on main blocks every publish, since the release job
runs them first.

## Full verification

```
pnpm install && pnpm build && pnpm typecheck && pnpm lint && pnpm test && pnpm dag:check
```
