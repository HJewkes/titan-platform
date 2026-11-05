---
"@titan-design/github": patch
---

`ciVerdict` judges an unpinned required context on its newest GitHub Actions run and its commit status together. It is green only when every source that reported succeeded, pending when either is still going or neither reported, and red otherwise, naming the run's conclusion first. Before, a `success` commit status made the context green even beside a newer failed or still-running Actions run of the same name, and a successful run hid a red status. Pinned contexts and the all-runs rule are unchanged.
