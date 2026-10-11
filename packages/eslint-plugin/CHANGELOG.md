# @titan-design/eslint-plugin

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
