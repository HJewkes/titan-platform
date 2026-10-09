# @titan-design/eslint-plugin

## 0.1.0

### Minor Changes

- 9085991: The package is now public on npm and accepts ESLint 9 or 10 as a peer. Its rules use only `context.sourceCode`, so no rule changed.
- 8fb191e: Add the `no-commented-code` rule and a `recommended` flat config that enables `max-function-lines`, `no-commented-code` and `todo-needs-issue` at error.

### Patch Changes

- 6419e0a: `todo-needs-issue` now ties the task key to the TODO marker: `UTF-8`, `ES-2022` and keys inside URLs or later in the comment no longer count. `FIXME` stays unchecked.
