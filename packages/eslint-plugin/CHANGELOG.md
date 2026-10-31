# @titan-design/eslint-plugin

## 0.4.0

### Minor Changes

- 7492819: - **Count work in timing tests instead of reading a clock (TP-4262).** Glob growth tests compared thread CPU ratios, which read up to 415 on a loaded hosted runner and turned main red. fix-proof's `LinearRegExp` now counts its NFA steps (`linearRegExpSteps`), and test-kit's `linearWork` compares those counts across a size ladder. It replaces the timed `linearGrowth`, which is removed. A matcher that falls back to a backtracking RegExp counts nothing and fails at size 1. test-kit also adds `countCalls` and `callMeter`, which count calls to chosen methods and stop at a cap. fix-proof's brace and glob rows and code-graph's reach and link rows use them in place of millisecond limits.
  - **Refuse new clock limits in tests.** eslint-plugin adds `no-test-clock-budget`. It reports a test that compares a clock reading, or a ratio of readings, with a limit outside a bench gate. The repo enables it with a shrink-only baseline that TP-4264 empties.
- 1b2977c: Add the opt-in `no-wall-clock-motion` rule. In files under `/ui/beats/` or `/motion/` (option `paths`), it reports `Date.now`, `performance.now`, `Math.random` and the timer calls, and it ignores test and spec files, so beat motion stays a function of the beat's time.

### Patch Changes

- 6c852fa: `no-test-clock-budget` no longer overflows the stack on a loop that walks a property of its own variable, such as `node = node.parentElement` (TP-4266). Each pass of the self-write grew the property path the rule followed, so its seen-guard never matched. The rule now stops following a name past 8 nested property reads.
- 5edd38d: Use the shared `isRecord` and `isObjectLike` from `@titan-design/rpc-protocol/narrow` in place of local copies. Behaviour is unchanged.
- ad5bd85: Narrow rule options and parser output with type guards instead of assertions; rule reports are unchanged.
- Updated dependencies [5edd38d]
  - @titan-design/rpc-protocol@0.4.0

## 0.3.0

### Minor Changes

- 51b584a: Add the opt-in `max-line-length` rule (TP-2475 a): a code line longer than `max` characters (default 200, `DEFAULT_MAX_LINE_LENGTH`) is reported, unless it is a comment, part of an import or re-export, or at least half string, template or regex literal. It is not in `recommended`.

## 0.2.0

### Minor Changes

- c1fad33: `@titan-design/eslint-plugin` adds `no-chained-type-assertions`, which reports a type assertion
  applied to another one (`x as unknown as T`), and enables it in `recommended`.
  The new `@titan-design/test-kit` package exports `partialFake<T>()`, which builds a typed test fake
  from only the fields a test reads, so test files need no double cast.
- c990f0c: Add `no-internal-module-mock`, enabled in `recommended`. Tests may mock only external dependencies. A `vi.mock` or `jest.mock` of a relative, absolute or `#` specifier, or of a package under `internalPrefixes` (default `@titan-design/`), is reported. `node:` builtins and third-party packages stay mockable.

## 0.1.0

### Minor Changes

- 9085991: The package is now public on npm and accepts ESLint 9 or 10 as a peer. Its rules use only `context.sourceCode`, so no rule changed.
- 8fb191e: Add the `no-commented-code` rule and a `recommended` flat config that enables `max-function-lines`, `no-commented-code` and `todo-needs-issue` at error.

### Patch Changes

- 6419e0a: `todo-needs-issue` now ties the task key to the TODO marker: `UTF-8`, `ES-2022` and keys inside URLs or later in the comment no longer count. `FIXME` stays unchecked.
