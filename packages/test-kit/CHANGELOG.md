# @titan-design/test-kit

## 0.2.0

### Minor Changes

- 7492819: - **Count work in timing tests instead of reading a clock (TP-4262).** Glob growth tests compared thread CPU ratios, which read up to 415 on a loaded hosted runner and turned main red. fix-proof's `LinearRegExp` now counts its NFA steps (`linearRegExpSteps`), and test-kit's `linearWork` compares those counts across a size ladder. It replaces the timed `linearGrowth`, which is removed. A matcher that falls back to a backtracking RegExp counts nothing and fails at size 1. test-kit also adds `countCalls` and `callMeter`, which count calls to chosen methods and stop at a cap. fix-proof's brace and glob rows and code-graph's reach and link rows use them in place of millisecond limits.
  - **Refuse new clock limits in tests.** eslint-plugin adds `no-test-clock-budget`. It reports a test that compares a clock reading, or a ratio of readings, with a limit outside a bench gate. The repo enables it with a shrink-only baseline that TP-4264 empties.
- 7a34209: The remaining RegExp glob compilers match in time linear in the path (TP-4223). fix-proof exports `LinearRegExp`, also from `@titan-design/fix-proof/linear-regexp`: a RegExp whose `test` simulates its source as an NFA, so a glob such as `d/` and twenty `*`, or `**/` repeated twelve times, can no longer hang a match. review-panel's `matchesGlob`, autoresearch's bounds globs, code-graph's `patternToRegex` and `.gitattributes` patterns, and tool-guard's merge-lint `globToRegExp`, guarded path patterns and glob command words now build one. Each still returns a RegExp and matches what it did, except that a glob too large for V8 to compile, which used to throw at its first test, now matches as written. test-kit exports `linearGrowth`, a growth-ratio ladder that fails a polynomial matcher on a small input before trying a large one, and `hostileGlobs`, the timing rows of tp#2491.
- 8b92ba0: - **Git fixtures in test-kit (TP-4446).** A new `@titan-design/test-kit/git` subpath holds the template repositories worktree's tests used: `seedRepo` and `seedRepoWithOrigin` build each seed once per test file and copy it per test, with auto-maintenance, gc and fsync off and an empty hooks directory. `withHistory` writes many commits with one `git fast-import` at pinned dates, `fixtureEnv` drops injected `GIT_CONFIG_*` entries and host config, and `gitIn` runs git in a directory under it. The subpath takes `vitest` as an optional peer dependency.
  - worktree's tests use the subpath; its private `git-fixture` and `test-env` copies are deleted. No runtime change.
- 0d409d8: `withHistory` commits take an optional `date` and `author`, so a history test can pin each commit's date and count its authors from one `git fast-import`. A commit that names neither keeps the pinned date and fixture identity. Templates are also cheaper to build: their config is written in one file append rather than one `git config` per key, and the bare origin is built only on the first `seedRepoWithOrigin`.

## 0.1.0

### Minor Changes

- c1fad33: `@titan-design/eslint-plugin` adds `no-chained-type-assertions`, which reports a type assertion
  applied to another one (`x as unknown as T`), and enables it in `recommended`.
  The new `@titan-design/test-kit` package exports `partialFake<T>()`, which builds a typed test fake
  from only the fields a test reads, so test files need no double cast.
