---
"@titan-design/github": minor
"@titan-design/factory": patch
---

`Commit` gains an optional `message`, which the gh adapter reads from the git commits API. Shepherd's ci-wait no longer waits out its 45 minutes on a head GitHub Actions started no run for: past a 5 minute grace, a conflicting head goes to the conflict fix round, and a skip token in the head commit message wakes the fixer to push a fresh commit. An unsettled mergeable state or a failed read keeps the wait as before.
