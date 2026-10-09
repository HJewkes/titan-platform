---
"@titan-design/github": minor
---

`merge` and `rerunFailed` now survive a 5xx or an unreadable answer. Each failed write is followed by a read-back: a PR merged at the pinned head, or a run that is queued again, counts as done. Otherwise the write is sent once more, still pinned to the same head, and a second failure throws `WriteRetriesExhaustedError` naming the step. A 4xx is never retried. The fake GitHub gains `mergeFaults` and `rerunFaults`.
