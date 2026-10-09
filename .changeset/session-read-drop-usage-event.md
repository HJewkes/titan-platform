---
"@titan-design/session-read": minor
---

Remove the deprecated `usage` event (breaking). `SessionEvent` no longer has a `usage` kind, `TranscriptDelta.usage` and the `UsageRow` type are gone, and `EventFolder` no longer folds usage. The `usage` rows counted a response written over two lines twice. Read `delta.requests` instead and dedupe on `requestId`, as session-graph's rollup already does.

No known consumer reads the removed API. `git grep -n -E 'delta\.usage|UsageRow'` finds 0 hits in each of these:

| repo | pinned sha | current `origin/main` |
|---|---|---|
| active-work | 1ebd7b9: 0 | d30d956: 0 |
| agent-chat | c1e47ca: 0 | 9383846: 0 |
| relay (private) | pinned: 0 | current: 0 |
| codewatch | 91dc543: 0 | dc9f4ef: 0 |
| brain | 760ce01: 0 | 760ce01: 0 |
| titan-platform outside session-read | n/a | 513c0cce: 0 |

`EXTRACT_VERSION` stays at 7. No stored row comes from the `usage` event: session-graph rebuilds `session_model_usage` from `request` rows, so a re-extract would change nothing.
