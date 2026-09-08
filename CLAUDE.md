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
Merging that PR publishes via npm trusted publishing. A brand-new package must be
published once by hand before its trusted publisher can be configured on npmjs.com.
