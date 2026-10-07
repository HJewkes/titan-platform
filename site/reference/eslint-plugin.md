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
- You want commented-out code deleted.

To run ESLint against a style profile and get normalized diagnostics, use `style-checker`.

## Public API

| Export | What it does |
|---|---|
| default export | the plugin: `meta.name` and `rules` with `max-function-lines`, `no-commented-code` and `todo-needs-issue` |
| `maxFunctionLines` | reports a function, arrow function or method with more than `max` (default 30) non-blank lines, naming it by its id, variable, key or as `anonymous function` |
| `DEFAULT_MAX_LINES` | `30` |
| `noCommentedCode` | reports a comment whose text parses as statements and carries a code signal: any statement other than an expression statement, or an expression that is an assignment, call, `new`, `await`, `++`/`--` or optional chain, or text ending in `;`. A bare `continue`, `break`, `return` or `debugger` and a lone expression without a signal (`read-only`, `100 - 75`, `a, b`, `this`) and a manual page reference such as `sudo(8)` read as prose. Consecutive whole-line `//` comments are parsed together; trailing comments never join. Leading `*` on block comment lines is stripped. JSDoc, `eslint-*`, `@ts-*`, `istanbul`/`c8`/`v8 ignore`, `prettier-ignore`, `#!` and `/// <reference` comments always pass |
| `recommended` | a flat config registering the plugin as `titan` and enabling all three rules at `error` |
| `todoNeedsIssue` | reports each `TODO` in a comment that is not immediately followed by a tracker key (`TODO(TP-123)`, `TODO: TP-123`) or an issue number (`TODO(#123)`, `TODO #123`); a bare token must end the sentence, so `TODO UTF-8 support` is reported, as is any bare key with a standards prefix (`UTF`, `ES`, `ISO`, `RFC`, `SHA`, `MD`, `TLS`, `SSL`, `IPV`, `ECMA`, `HTTP`) |

## Example

```js
// eslint.config.js
import titan from "@titan-design/eslint-plugin";

export default [
  {
    plugins: { titan },
    rules: {
      "titan/max-function-lines": "error",
      "titan/no-commented-code": "error",
      "titan/todo-needs-issue": "error",
    },
  },
];
```

Or enable all three with `import { recommended } from "@titan-design/eslint-plugin"` and `export default [recommended]`.

## Rules and messages

`max-function-lines`:

```text
`<name>` is <n> lines; the limit is 30. Extract one step into a named function in this file. Do not add eslint-disable and do not edit the suppressions file.
```

`no-commented-code`:

```text
This comment is code. Delete it; git history keeps it. If it explains why, rewrite it as a sentence.
```

`todo-needs-issue`:

```text
TODO needs a task id, for example `TODO(TP-123): ...`. File the task with `active-work task add`, or delete the comment.
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

- It has no baseline of its own. Existing long functions are grandfathered by the consuming
  repo's suppressions, not by the rule.

## Gotchas

- Blank lines are skipped but comment lines count, so a long doc comment inside a function
  body counts toward the limit.
- An outer function's count includes the lines of any function nested inside it, as in core `max-lines-per-function`; the nested function is also checked on its own.
- Names come from the declaration id, variable, property or class key. An assigned `obj.m = function () {}` and an anonymous default-export function report as `anonymous function`; `export default function main()` reports as `main`.
- `TODO` is matched case-sensitively; `todo` in prose is ignored, and a lowercase key such
  as `tp-123` is not a task id.
- A comment such as `// note: see below` passes, but a prose line that happens to be a call, such as `// Note (important)`, is reported. A bare `continue`, `break`, `return` or `debugger` (and a TypeScript-only shape such as `// Map<string, number>`) reads as prose under both espree and typescript-eslint; commented JSX is not caught.
- `FIXME` is not checked; only `TODO` needs a task.

## Where it came from

New, built for the TP-897 code-quality enforcement plan.
