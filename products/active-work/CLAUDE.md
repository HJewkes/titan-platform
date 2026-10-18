# active-work — repo notes for Claude

This product lives in the titan-platform monorepo. The root `CLAUDE.md` rules (tiers,
changesets, the six gates) apply here too.

## Stack

- Node 24, ESM only (`"type": "module"`)
- TypeScript strict, target ES2022, module Node16, extending the root `tsconfig.base.json`
- Package manager: pnpm workspace; `@titan-design/*` dependencies are `workspace:^`
- Build: tsup → ESM bundle of `src/cli.ts` to `dist/`
- Tests: root vitest (the projects for `__tests__/` arrive in TP-624 S1b)
- Lint: the root eslint config, with pre-existing hits in `eslint-suppressions.json`

## Layout

| Path | What's here |
|---|---|
| `src/cli.ts` | Entrypoint; wires commander to the command registry |
| `src/commands/` | One file per CLI command; each exports a registry entry |
| `src/registry/` | Command registry types, JSON envelope, dispatcher contract |
| `src/schemas/` | Zod schemas for brief/task/session/artifacts/state |
| `src/utils/` | fs-atomic, flock, frontmatter/YAML I/O, paths, slug |
| `src/server/` | hono HTTP + WS + MCP-over-HTTP daemon |
| `src/dashboard/` | React read-only web UI; built with vite (separate config) |
| `src/migrations/` | Schema migrations keyed by `from` version |
| `src/lint/` | Per-artifact lint rules (warn-only) |
| `src/templates/` | Mustache templates for scaffolding |
| `src/bootstrap/` | Bootstrap prompt assembly |
| `src/discover/` | gh / git / projects / Claude session discovery sources |
| `skill/` | SKILL.md + references; copied to `~/.claude/skills/active-work/` by postinstall |
| `scripts/` | postinstall, preuninstall |
| `__tests__/` | Vitest tests; fixtures under `__tests__/fixtures/` |

## Commands

From this directory:

```bash
pnpm dev <args>      # tsx src/cli.ts <args>
pnpm typecheck
pnpm build           # tsup + vite dashboard
```

## Verify before opening a PR

Run the root gates from the repo root, each green:
`pnpm build && pnpm typecheck && pnpm lint && pnpm test && pnpm dag:check && pnpm docs:build`.
A fresh worktree needs `pnpm install --frozen-lockfile` first. The postinstall and
preuninstall scripts exit early outside a `node_modules` path, so a workspace install
leaves `~/.claude` alone.

## Conventions

- **CLI is non-interactive by default** — Claude is the primary caller. Interactive UX is reserved for `active-work open` picker, `active-work setup` wizard, and explicit `--interactive` flags.
- **One source of truth for command surface** — `src/registry/`. CLI and MCP both consume it; never hand-maintain MCP tool definitions.
- **All persisted data goes through validating writers** — never write to `brief.md`, `tasks/*.yml`, `artifacts.yml` or `sessions/*.md` without schema validation. (`handoff.md` no longer exists; the v2→v3 migration retired it.)
- **Atomic writes + flock per-initiative** — read-modify-write paths must use `withFileLock` from `src/utils/fs-atomic.ts`.
- **The active root is per-platform, resolved via `env-paths`** — on macOS `~/Library/Application Support/active-work/`, **not** `$XDG_DATA_HOME`, which `env-paths` ignores entirely on darwin. Never hardcode it, and never assume the XDG variables apply.

  ⚠️ **The only safe override is the `ACTIVE_ROOT` env var**, which is what `__tests__/setup/test-helpers.ts` uses. Setting `XDG_DATA_HOME` expecting redirection does nothing and leaves you pointed at the operator's live data — an agent did exactly that and created ten synthetic initiatives in the real root. Anything that writes during a test must go through those helpers, which now refuse to delete a directory that is not one of their own temp dirs.

## Reference

Brain (`~/projects/brain`) is the closest sibling project in style. Use it as a reference for build patterns, MCP server layout, dashboard scaffolding, and postinstall behavior — but don't import from it.
