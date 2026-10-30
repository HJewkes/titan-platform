---
"@titan-design/owner-queue": minor
---

A deposit may carry an optional `blocker: { since, blocks }`, marking its asker as hard-blocked since a given time. It is allowed only on decide, approve and do deposits, `since` must be no more than 5 minutes ahead or 30 days behind the filing time, and a blocker deposit without `unblocksNow` takes `blocks` as its unblock line. Deposits without it parse unchanged.
