---
"@titan-design/factory": minor
---

Shepherd dispatches reviews from one queue. A review queues once and starts from the queue's front on three triggers: when it is queued, when a review ends, and on a one-minute tick while any review waits. A deferred review no longer sleeps and asks again on its own, so nothing polls per pull request, and the rule that dropped an ask that stopped asking is gone. A queued review whose pull request moved to a new head or closed is dropped and its step told at once. A review still queued after the 3 hour machine-hold ceiling gives up as before. A queued review whose step is cancelled or shut down leaves the queue at once and never starts.
