# @titan-design/eslint-plugin

ESLint rules for the titan code-quality limits. Each message tells the reader what to do
next, so an agent that hits the rule can fix the code without asking.

- `max-function-lines`: a function may have at most 30 non-blank lines (option `max`).
  Blank lines are not counted; comment lines are.
- `todo-needs-issue`: every `TODO` in a comment must carry its task right after the marker:
  `TODO(TP-123)`, `TODO(#123)`, or a bare `TODO: TP-123` / `TODO #123` that ends the
  sentence. `TODO UTF-8 support`, `TODO ES-2022` (keys with a standards prefix such as `UTF`, `ES`, `ISO`, `RFC`, `SHA`, `MD`, `TLS`, `SSL`, `IPV`, `ECMA`, `HTTP` are prose), and a key that sits later in the comment
  or inside a URL are reported. `FIXME` is deliberately not checked; the rule is about `TODO`.

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

Status: unpublished (`private`). The first publish and a `recommended` config follow in
later TP-897 slices.
