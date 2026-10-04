# eslint-plugin

**Tier 0.** No titan dependencies. `eslint` 9 is a peer dependency.

```sh
npm install --save-dev @titan-design/eslint-plugin eslint
```

Status: unpublished. The package is `private` until its first publish.

## The problem it solves

The titan standards cap functions at about 30 lines and forbid a TODO without a tracking
task. Before this package those rules lived only in prose, so nothing caught a breach until
review. This package adds both as ESLint rules whose messages name the fix.

## When to reach for it

- You want CI to fail on a function longer than 30 non-blank lines.
- You want every TODO comment to carry a task id.

To run ESLint against a style profile and get normalized diagnostics, use `style-checker`.

## Public API

| Export | What it does |
|---|---|
| default export | the plugin: `meta.name` and `rules` with `max-function-lines` and `todo-needs-issue` |
| `maxFunctionLines` | reports a function, arrow function or method with more than `max` (default 30) non-blank lines, naming it by its id, variable, key or as `anonymous function` |
| `DEFAULT_MAX_LINES` | `30` |
| `todoNeedsIssue` | reports each comment containing `TODO` that has neither a tracker key (`TP-123`) nor an issue number (`#123`) |

## Example

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

A 31-line function reports:

```text
`loadAll` is 31 lines; the limit is 30. Extract one step into a named function in this file. Do not add eslint-disable and do not edit the suppressions file.
```

A bare `// TODO: later` reports:

```text
TODO needs a task id, for example `TODO(TP-123): ...`. File the task with `active-work task add`, or delete the comment.
```

## What it deliberately does not do

- It ships no `recommended` config yet and no commented-out-code rule; later slices add them.
- It has no baseline of its own. Existing long functions are grandfathered by the consuming
  repo's suppressions, not by the rule.

## Gotchas

- Blank lines are skipped but comment lines count, so a long doc comment inside a function
  body counts toward the limit.
- An outer function's count includes the lines of any function nested inside it.
- `TODO` is matched case-sensitively; `todo` in prose is ignored, and a lowercase key such
  as `tp-123` is not a task id.

## Where it came from

New, built for the TP-897 code-quality enforcement plan.
