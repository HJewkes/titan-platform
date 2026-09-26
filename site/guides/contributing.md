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

All six must be green:

```sh
pnpm build && pnpm typecheck && pnpm lint && pnpm test && pnpm dag:check && pnpm docs:build
```

Zero lint warnings in files you touched. `pnpm build` has to precede `pnpm test` and
`dag:check`, because an import of a workspace package by its published name resolves
through that package's built `dist/*.d.ts` entry.

## Before adding code

1. Read the [capability catalog](/guides/capabilities) and the reference page of every unit
   that looks close.
2. Name the existing unit you reuse, or the gap you fill and its task, in the plan and the PR.
3. Verify runtime and auth assumptions with the path's smoke check before you build on them.

## Adding a package

Never hand-copy a package. Stamp it:

```sh
pnpm new:package <name> --tier <0|1|2|ui|product> --description "..." --task TP-n
pnpm install
```

That copies `templates/package`, fills in the name and tier, registers the package in
`.codewatch/check.json` under its tier, stamps `site/reference/<name>.md` from
`templates/reference-page.md`, and regenerates the index and sidebar. Edit the `$tiers` map,
never `layers` directly.

The stamped reference page is a placeholder with every section heading and no content. Fill
it in before the package ships; a second stamp of the same name leaves an existing page
untouched, so hand-written prose is never flattened.

The stamp also copies `templates/package/CAPABILITY.md`: the package's "use this when" line
for the [capability catalog](/guides/capabilities). Replace its placeholder in the same pull
request; `pnpm new:package` regenerates the catalog so the new row shows up at once.

The docs build is a pull-request gate, not just a deploy step: `validate` runs
`pnpm docs:build` on every pull request, so a public package with no reference page turns
the required check red before merge. See [the reference index](#the-reference-index) below.

## Checking the DAG locally

A package may import only packages in its own tier or a lower one. `pnpm dag:check`
enforces it, self-hosted against this repo's own `@titan-design/code-graph`:

```sh
pnpm build && pnpm dag:check
```

`pnpm build` has to run first; `dag:check` imports the package's built output. Set
`BASE_REF=origin/main` to report only violations that are new relative to main, which is
what CI does. `scripts/dag-check.sh` remains for one release as a fallback that needs
`CODEWATCH_CLI` pointed at a built codewatch checkout.

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
`release.yml`. Never add a token to `release.yml`.

A red `lint`, `typecheck`, or `test` on main blocks every publish, since the release job
runs them first.

### The first publish of a brand-new package

npm accepts a trusted publisher only for a package that already exists on the registry, and
it has no pending-publisher feature that would let one be added ahead of time
(npm/cli#8544). So a package's very first version is published once, by hand, from the
owner's own terminal. Land the package on main first, then:

1. **Log in interactively.** `npm login --auth-type=web` from the owner's terminal. This
   needs a human present for the browser challenge and cannot run in CI.
2. **Publish from the built package.** From the package's directory, `pnpm publish --access
   public --no-git-checks`. Always pnpm, never `npm publish`: only pnpm rewrites
   `workspace:^` dependency ranges into real version ranges, so an `npm pack` tarball for an
   unreleased package is uninstallable.
3. **A new package sits at `0.0.0` on main until its "Version Packages" pull request
   merges.** Publishing `0.0.0` by hand as a placeholder version is fine; the changeset
   release bumps it from there.
4. **Add the trusted publisher.** On the new package's npmjs.com settings page: GitHub
   Actions, user `HJewkes`, repository `titan-platform`, workflow `release.yml`, no
   environment, "Allow npm publish" checked.
5. **Every later release of that package goes through `release.yml`.** No token is created
   at any point in this procedure.

One ordering trap: hold the "Version Packages" pull request until every new package it
depends on already exists on npm, or the dependent package's publish fails looking for a
version that isn't there yet.

::: warning Do not bump the pnpm pin casually
`packageManager` pins `pnpm@9.15.0`. From v11, `pnpm publish` is implemented natively and
no longer delegates to the npm CLI — and that delegation is what performs the OIDC
exchange trusted publishing relies on. Any pnpm upgrade needs a real publish to verify.
:::

## The docs site

```sh
pnpm docs:dev      # local server with hot reload
pnpm docs:build    # regenerates the reference index, then builds to site/.vitepress/dist
pnpm docs:preview  # serve the built output
```

`.github/workflows/pages.yml` deploys the site to GitHub Pages on every push to main. The
build itself is guarded earlier: `ci.yml`'s `validate` job runs `pnpm docs:build` on every
pull request with no path filter, so a change under `packages/` that breaks the reference
fails the required check rather than the deploy.

### The reference index {#the-reference-index}

`pnpm docs:reference` (which `docs:build` runs first) reads `.codewatch/check.json` and
every workspace `package.json`, then writes two files that are committed:

- `site/reference/index.md` — the tier tables on [Packages](/reference/)
- `site/.vitepress/reference-sidebar.json` — the sidebar nav

A new package therefore never needs a hand edit to the nav. The script *fails* if a public
package has no `site/reference/<name>.md`, which is the mechanism that stops an undocumented
package from shipping. `pnpm new:package` stamps that page and reruns the script, so the
default path is green without a hand edit.

### The capability catalog {#the-capability-catalog}

`pnpm capabilities` writes `CAPABILITIES.md` at the repository root and
`site/guides/capabilities.md` from the same data. It reuses the reference index's package
discovery, then adds each unit's version, its key exports parsed from `src/index.ts` (capped
at twelve, runtime values before types), and the text of its `CAPABILITY.md`. The runtime
paths and known gaps come from `scripts/capabilities-data.json`, which is edited by hand.

Both outputs are committed. `validate` runs `pnpm capabilities:check`, which regenerates in
memory and fails when either file differs, so edit the sources and rerun the script. The
"Version Packages" pull request stays green because `pnpm version-packages` regenerates the
catalog after bumping versions. The script fails when a unit has no `CAPABILITY.md`.

Page bodies are hand-written on purpose. Generating them from type signatures produces a
list of exports, not an explanation of when to reach for the package.
