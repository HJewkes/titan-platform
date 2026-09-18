# titan-platform

pnpm monorepo of `@titan-design/*` packages arranged as a strict acyclic DAG, plus
`products/*` composed from them. Read `README.md` for layout and conventions; this file is
the short version for agents.

## Shared code: the titan-platform pattern

**Where shared code lives.** Reusable engine code lives in the titan-platform monorepo
(`~/projects/titan-platform`, `packages/*`), published to npm as `@titan-design/*`. Product
repos (active-work, agent-chat, relay, codewatch) are thin compositions over those packages.
The design system is separate: `~/projects/titan-design` publishes `@titan-design/react-ui`.

**Before building new functionality, ask three questions in order.**

1. Does a `@titan-design/*` package already do this? Read the package list in
   `titan-platform/README.md` and the package's own README. If yes, install it from npm.
   Never copy its source and never use a relative `file:` dependency.
2. Is it product-specific (this product's policy, vocabulary, or UI)? Then build it here.
3. Would a second product plausibly want it? Then build it in titan-platform as a package,
   or extend an existing one, release it through changesets, and consume the release here.
   File the package work as a TP task in the titan-platform initiative and link it from
   this initiative's task.

**When a package almost fits,** do not fork it locally. File a TP task naming the missing
export. Either wait for the release or build a product-side adapter that is deleted when
the release lands.

**Tier rule.** Packages depend only on lower tiers (0 primitives, 1 engines, 2 domain).
Products never depend on another product's source. They talk over a process boundary
(CLI, loopback HTTP, MCP).

**Extraction is not done until the source repo consumes the package.** An extraction that
leaves the original copy in place creates two diverging implementations. The swap-back is
part of the same task.

Full roadmap and evidence:
`active-work/titan-platform/sources/design-consolidation-roadmap.md` (2026-09-18).

**What this means here.** titan-platform is the home of the packages. An extraction
task's done-when includes the source repo consuming the release and deleting its copy.
`@titan-design/code-graph` is the cautionary case: extracted from codewatch, never swapped
back, and now a 14 percent subset of the original by lines.

## Before you finish any change

```
pnpm build && pnpm typecheck && pnpm lint && pnpm test && pnpm dag:check && pnpm docs:build
```

All six must be green. `dag:check` is self-hosted: it runs against this repo's own
`@titan-design/code-graph`, built by `pnpm build`. `scripts/dag-check.sh` remains for one
release as a fallback that needs `CODEWATCH_CLI` pointed at a built codewatch checkout.
Zero lint warnings in files you touched.

## Rules that CI enforces

- **Tier order.** A package imports only its own tier or lower. The `package-layers` rule in
  `.codewatch/check.json` is the DAG. Edit its `$tiers` map, never `layers` directly;
  `pnpm new:package <name> --tier <0|1|2|ui|product>` does this for you.
- **Changesets.** Any change under `packages/*` needs a changeset (`pnpm changeset`) or the
  PR fails. Packages version independently.
- **Uniform scaffold.** Never hand-copy a package; stamp it with `pnpm new:package`. It also
  stamps `site/reference/<name>.md` from `templates/reference-page.md` and refreshes the
  generated index and sidebar. Fill the page in; a re-stamp never overwrites it.
- **Docs build.** The `validate` job runs `pnpm docs:build` on every pull request, with no
  path filter. A public package with no reference page fails that check before merge.

## Conventions

- ESM only, `verbatimModuleSyntax`, `import type` for type-only imports.
- Tests live next to source as `*.test.ts`, run from the root with vitest. Test behavior.
- Functions stay under about 30 lines. Comments explain why, never what.
- `zod` is a peer dependency of packages that use it, never a regular dependency.
- Products own surface wiring (commander, MCP SDK transports, hono servers); packages
  expose surface-independent cores.

## Releasing

Merging to main lets the Release workflow open or refresh the "Version Packages" PR.
Merging that PR publishes via npm trusted publishing. Never add a token secret to
`release.yml`.

A brand-new package cannot use that path yet: npm only accepts a trusted publisher for a
package that already exists. Its first publish runs through `bootstrap-publish.yml`:

1. On npmjs.com create a granular access token — `@titan-design` scope only, organizations
   "No access", "Read and write (publish and stage)", Bypass 2FA on, expiry 1 day (the
   floor; 90 days is the cap for a write token). Store it as `NPM_BOOTSTRAP_TOKEN` on the
   `npm-bootstrap` GitHub environment, never as a repo secret.
2. Dispatch **Bootstrap publish** (optionally with a `package` input) and approve the
   environment review. It publishes only packages npm answers 404 for.
3. Add the trusted publisher on the new package's npmjs.com settings page. This needs an
   interactive 2FA challenge and cannot be automated.
4. Delete the token or let it expire. Every later release is token-free.

Around January 2027 npm removes direct publishing from bypass-2FA tokens; step 2 then has
to become `npm stage publish` plus a human 2FA approval.

Do not bump the `packageManager` pin (`pnpm@9.15.0`) without testing a real publish. pnpm
implements `publish` natively from v11 instead of delegating to the npm CLI, and that
delegation is what performs the OIDC exchange release.yml depends on.
