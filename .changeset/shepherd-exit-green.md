---
"@titan-design/factory": patch
---

ci-wait no longer reads red on a check that concluded skipped or neutral, or on an older failed run whose newer run of the same check at that head is still going or ran nothing (a skipped duplicate run, a rerun in flight). Such a head is waited on, never merged. After a ci-red fixer exits with no push, the wait behind the owner's sent-back gate and the seat's dead-end respawn or replan now also ends when every required check at the unchanged head turns green, as the seat-notice wait already did; any other exit still waits for a new head.
