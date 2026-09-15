# titan-platform

pnpm monorepo of `@titan-design/*` packages arranged as a strict acyclic DAG, plus
`products/*` composed from them. Read `README.md` for layout and conventions; this file is
the short version for agents.

## Before you finish any change

```
pnpm build && pnpm typecheck && pnpm lint && pnpm test && pnpm dag:check
```

All five must be green. `dag:check` needs codewatch built at
`~/projects/codewatch/packages/cli/dist/index.js` (or set `CODEWATCH_CLI`). Zero lint
warnings in files you touched.

## Rules that CI enforces

- **Tier order.** A package imports only its own tier or lower. The `package-layers` rule in
  `.codewatch/check.json` is the DAG. Edit its `$tiers` map, never `layers` directly;
  `pnpm new:package <name> --tier <0|1|2|ui|product>` does this for you.
- **Changesets.** Any change under `packages/*` needs a changeset (`pnpm changeset`) or the
  PR fails. Packages version independently.
- **Uniform scaffold.** Never hand-copy a package; stamp it with `pnpm new:package`.

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
