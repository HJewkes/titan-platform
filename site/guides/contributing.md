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

The docs build is a pull-request gate, not just a deploy step: `validate` runs
`pnpm docs:build` on every pull request, so a public package with no reference page turns
the required check red before merge. See [the reference index](#the-reference-index) below.

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
`release.yml`. Never add a token to `release.yml`.

A red `lint`, `typecheck`, or `test` on main blocks every publish, since the release job
runs them first.

### The first publish of a brand-new package

npm accepts a trusted publisher only for a package that already exists on the registry, so
a package's very first version cannot come from `release.yml`. It comes from
`.github/workflows/bootstrap-publish.yml`, the one workflow that carries a token. Land the
package on main first, then:

1. **Create a short-lived token.** On npmjs.com, *Access Tokens → Generate New Token →
   Granular*. Packages and scopes: "Only select packages and scopes", the `@titan-design`
   scope, permission "Read and write (publish and stage)". Organizations: "No access".
   Check **Bypass 2FA**, which an unattended publish needs. Set the expiry to **1 day** —
   npm's floor is one day and its cap for a write token is 90.
2. **Store it on the environment, not the repo.** Add it as `NPM_BOOTSTRAP_TOKEN` under
   *Settings → Environments → `npm-bootstrap` → Environment secrets*. Create that
   environment once with **required reviewers**; the review is what stops an ordinary push
   from reaching a publish token.
3. **Dispatch the workflow.** *Actions → Bootstrap publish → Run workflow*, optionally
   naming one `package`. Approve the environment review. The job runs
   `scripts/bootstrap-publish-candidates.mjs`, which asks `npm view <name> version` about
   every public package under `packages/*` and publishes only the ones npm answers 404
   for. A package that already exists is never republished.
4. **Add the trusted publisher.** On the new package's npmjs.com settings page, point it at
   `HJewkes/titan-platform` and `release.yml`. This step needs an interactive 2FA challenge
   and cannot be automated: since 2026-07-31, npm blocks bypass-2FA tokens from changing
   trusted-publishing configuration.
5. **Delete the token,** or let the one-day expiry do it.

Every later release of that package then goes through `release.yml` with no token at all.

Two dates worth knowing. Around **January 2027** npm removes direct publishing from
bypass-2FA tokens, leaving them able to stage a publish that a human approves with 2FA;
step 3 has to move to `npm stage publish` then. And the bootstrap job publishes with
`pnpm publish`, not `npm publish`, because only pnpm rewrites `workspace:^` dependency
ranges into real version ranges — `npm pack` leaves them literal and produces an
uninstallable tarball.

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

Page bodies are hand-written on purpose. Generating them from type signatures produces a
list of exports, not an explanation of when to reach for the package.
