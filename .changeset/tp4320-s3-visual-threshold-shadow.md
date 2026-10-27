---
"@titan-design/factory": minor
---

Add `shepherd.visualThreshold`, a per-repo config key read at each merge evidence step. Under `shadow` or `on` the
evidence records `visualDelta`: each changed snapshot's share of its content box, measured from the merge base to the
head, plus the public API, token and harness paths the PR changes. A snapshot that cannot be measured records as
`unmeasured` with its reason. The merge decision is unchanged.
