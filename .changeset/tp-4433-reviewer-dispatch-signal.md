---
"@titan-design/review-panel": minor
---

`ReviewerDispatch.spawn` and `resume` take an optional `AbortSignal` as their last argument. A dispatch that waits before starting the reviewer stops waiting, and starts nothing, once the signal aborts.
