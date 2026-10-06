---
"@titan-design/factory": patch
---

Shepherd's merge policy reads `repo-not-frozen` as met for a frozen repo's own fix PR (the PR registered against the freeze's fix task by its fixer), matching the freeze guard that already lets that PR land; every other PR in the repo still gates. Resync supersedes a pending approve-merge gate on that fix PR whose only unmet conditions are transient, while the repo is still frozen.
