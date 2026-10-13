---
"@titan-design/github": minor
"@titan-design/factory": patch
---

Add `jobSteps(repo, jobId)` to `GitHubPort` (wire: `getJobSteps`): an Actions job's steps in run order, each with its name and conclusion. The fake answers from `fake.jobSteps` and 404s a job with none seeded.

Shepherd's frozen-main and base-red holds now count a head's failing check as the base's only when it fails there at the same job step. A check that fails at another step, or whose step cannot be read, wakes the fixer.
