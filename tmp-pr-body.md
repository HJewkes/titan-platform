Adds `isRepo(value)` to `@titan-design/github`: a non-throwing predicate for a bare `owner/name`. `checkRepo` now calls it, so the throwing and non-throwing forms share one grammar.

- Owner follows GitHub's rules: 1 to 39 alphanumerics and single hyphens, no leading or trailing hyphen.
- Name: `[A-Za-z0-9._-]`, not all dots, no `..`.
- `owner/name.git` is refused. It names the same repo but compares unequal, so it would slip past a deny list (the old `isRepoKey` behavior; the old `isRepoSlug` accepted it).
- factory `isRepoSlug` is removed; registry.ts and cli.ts use `isRepo`. seats.ts uses `isRepo` and re-exports it as `isRepoKey` because commands.ts, tree-carry.ts, review.ts and config.ts import that name and are outside this task's file set. No caller outside factory imports either old name.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
