# @titan-design/eslint-plugin

ESLint rules for the titan code-quality limits. Each message tells the reader what to do
next, so an agent that hits the rule can fix the code without asking.

- `max-function-lines`: a function may have at most 30 non-blank lines (option `max`).
  Blank lines are not counted; comment lines are.
- `todo-needs-issue`: every `TODO` in a comment must carry its task right after the marker:
  `TODO(TP-123)`, `TODO(#123)`, or a bare `TODO: TP-123` / `TODO #123` that ends the
  sentence. `TODO UTF-8 support`, `TODO ES-2022` (keys with a standards prefix such as `UTF`, `ES`, `ISO`, `RFC`, `SHA`, `MD`, `TLS`, `SSL`, `IPV`, `ECMA`, `HTTP` are prose), and a key that sits later in the comment
  or inside a URL are reported. `FIXME` is deliberately not checked; the rule is about `TODO`.
- `no-commented-code`: a comment whose text parses as statements with a code signal (a declaration or control statement, an assignment, a call, `;`) is reported; a lone expression such as `read-only` or `100 - 75` is prose. JSDoc and directive comments pass.
- `no-chained-type-assertions`: a type assertion applied to another one, such as
  `x as unknown as T` or `<T>(x as unknown)`, is reported once at the outermost assertion. A chain
  made only of `as const` passes. In tests, build the fake with `partialFake<T>()` from
  `@titan-design/test-kit`. It reads syntax only, so it cannot see a double cast split across two
  statements (`const u: unknown = x; u as T`); type-aware `@typescript-eslint/no-unsafe-type-assertion`
  covers that.
- `no-internal-module-mock`: `vi.mock`, `vi.doMock`, `jest.mock`, `jest.doMock` and
  `jest.unstable_mockModule` may not target this repo's own code: a relative, absolute or `#`
  specifier, or one under an internal prefix (option `internalPrefixes`, default
  `["@titan-design/"]`). `node:` builtins and third-party packages stay mockable. It matches the
  `vi` and `jest` names only, so a renamed import (`import { vi as t }`) is not seen, and it skips
  a specifier built at run time.
- `recommended`: a flat config enabling all five rules at `error` under the `titan` namespace.

Tier 0 of the titan-platform DAG. May import only packages in the same tier or
below; the `package-layers` rule in `.codewatch/check.json` enforces this in CI.
`eslint` 9 is a peer dependency.

```js
// eslint.config.js
import titan from "@titan-design/eslint-plugin";

export default [
  {
    plugins: { titan },
    rules: { "titan/max-function-lines": "error", "titan/todo-needs-issue": "error" },
  },
];
```

Status: unpublished (`private`). The first publish follows in a later TP-897 slice.
