---
"@titan-design/test-kit": minor
"@titan-design/worktree": patch
---

- **Git fixtures in test-kit (TP-4446).** A new `@titan-design/test-kit/git` subpath holds the template repositories worktree's tests used: `seedRepo` and `seedRepoWithOrigin` build each seed once per test file and copy it per test, with auto-maintenance, gc and fsync off and an empty hooks directory. `withHistory` writes many commits with one `git fast-import` at pinned dates, `fixtureEnv` drops injected `GIT_CONFIG_*` entries and host config, and `gitIn` runs git in a directory under it. The subpath takes `vitest` as an optional peer dependency.
- worktree's tests use the subpath; its private `git-fixture` and `test-env` copies are deleted. No runtime change.
