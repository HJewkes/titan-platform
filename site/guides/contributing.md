# Working in the repo

## Layout

```
packages/     the shared tiers, published to npm as @titan-design/<name>
products/     apps composed from the tiers (private)
templates/    the uniform per-package scaffold that scripts/new-package.mjs stamps
scripts/      new-package.mjs, dag-check.sh, gen-docs-reference.mjs
site/         this documentation site (VitePress)
.codewatch/   check.json: the DAG and fitness rules codewatch enforces
```

pnpm workspace. Root scripts fan out with `pnpm -r run <script>`; there is no task runner.
One shared `tsconfig.base.json` (ES2022, NodeNext, strict, `verbatimModuleSyntax`).

## Before you finish any change

All five must be green:

```sh
pnpm build && pnpm typecheck && pnpm lint && pnpm test && pnpm dag:check
```

Zero lint warnings in files you touched. `pnpm build` has to precede `pnpm test` and
`dag:check`, because an import of a workspace package by its published name resolves
through that package's built `dist/*.d.ts` entry.

## Adding a package

Never hand-copy a package. Stamp it:

```sh
pnpm new:package <name> --tier <0|1|2|ui|product> --description "..." --task TP-n
pnpm install
```

That copies `templates/package`, fills in the name and tier, and registers the package in
`.codewatch/check.json` under its tier. Edit the `$tiers` map, never `layers` directly.

Then write `site/reference/<name>.md`. The docs build fails without it — see
[the reference index](#the-reference-index) below.

## Checking the DAG locally

A package may import only packages in its own tier or a lower one. codewatch enforces it
and is not on npm yet, so the check runs against a built checkout:

```sh
CODEWATCH_CLI=~/projects/codewatch/packages/cli/dist/index.js pnpm dag:check
```

That path is the default, so a plain `pnpm dag:check` works on a machine with codewatch
built next to this repo. Set `BASE_REF=origin/main` to report only violations that are new
relative to main, which is what CI does.

## Conventions

- ESM only, `verbatimModuleSyntax`, `import type` for type-only imports.
- Tests live next to source as `*.test.ts` and run from the root with vitest. Test
  behaviour, not implementation.
- Functions stay under about 30 lines. Comments explain why, never what.
- `zod` is a peer dependency of packages that use it, never a regular dependency.
- Products own surface wiring — commander, MCP SDK transports, hono servers. Packages
  expose surface-independent cores.
- Every CLI surface a package exposes takes `--json` and returns the JSON envelope.

## Changesets

Any change under `packages/*` needs a changeset or the pull request fails:

```sh
pnpm changeset
```

Packages version independently; there is no fixed group.

## Releasing

Merging to main lets the Release workflow open or refresh the "Version Packages" pull
request from pending changesets. Merging *that* pull request publishes the bumped packages
to npm.

Publishing uses npm trusted publishing (OIDC), so there is no token secret: each package
has a trusted publisher on npmjs.com pointing at `HJewkes/titan-platform` and
`release.yml`. A package's first publish must happen before its trusted publisher can be
configured, so bootstrap a brand-new package once by hand with `pnpm release` from a
logged-in shell.

A red `lint`, `typecheck`, or `test` on main blocks every publish, since the release job
runs them first.

## The docs site

```sh
pnpm docs:dev      # local server with hot reload
pnpm docs:build    # regenerates the reference index, then builds to site/.vitepress/dist
pnpm docs:preview  # serve the built output
```

`.github/workflows/pages.yml` builds the site on every pull request that touches `site/`
and deploys it to GitHub Pages on every push to main.

### The reference index {#the-reference-index}

`pnpm docs:reference` (which `docs:build` runs first) reads `.codewatch/check.json` and
every workspace `package.json`, then writes two files that are committed:

- `site/reference/index.md` — the tier tables on [Packages](/reference/)
- `site/.vitepress/reference-sidebar.json` — the sidebar nav

A new package therefore never needs a hand edit to the nav. The script *fails* if a public
package has no `site/reference/<name>.md`, which is the mechanism that stops an undocumented
package from shipping.

Page bodies are hand-written on purpose. Generating them from type signatures produces a
list of exports, not an explanation of when to reach for the package.
