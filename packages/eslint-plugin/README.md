# @titan-design/eslint-plugin

ESLint rules for the titan code-quality limits. Each message tells the reader what to do
next, so an agent that hits the rule can fix the code without asking.

- `max-function-lines`: a function may have at most 30 non-blank lines (option `max`).
  Blank lines are not counted; comment lines are.
- `todo-needs-issue`: a comment containing `TODO` must name a task, as a tracker key such as
  `TODO(TP-123)` or an issue number such as `#123`.

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
