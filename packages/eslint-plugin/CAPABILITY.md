# eslint-plugin: use this when

<!-- One to three sentences for a reader deciding whether to reuse this or build something new. Feeds CAPABILITIES.md. -->

You want ESLint to enforce the titan code-quality limits in a repo: `max-function-lines` (at most 30 non-blank lines per function), `no-commented-code` (no code in comments), `no-chained-type-assertions` (no `as unknown as T`), `no-internal-module-mock` (tests mock only external dependencies) and `todo-needs-issue` (every TODO names a task id). To run ESLint against a style profile and normalize its output, use `style-checker` instead.
