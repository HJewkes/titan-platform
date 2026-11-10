---
"@titan-design/session-analytics": minor
---

`cacheTtlWhatIf` splits rebuilds by the last action before the gap: `ci-wait`, `other-bash` or `end-of-turn`, as `byGapCause`. `readTtlRows` takes the action from the previous request's tool calls in the same sidechain, and the text render adds a by-gap-cause table.
