---
"@titan-design/github": minor
"@titan-design/factory": patch
---

Add `jobSteps(repo, jobId)` to `GitHubPort` (wire: `getJobSteps`): an Actions job's steps in run order, each with its name and conclusion. The fake answers from `fake.jobSteps` and 404s a job with none seeded.

Shepherd's frozen-main and base-red holds now count a head's failing check as the base's only when it fails there at the same job step, and every failing test id (or, with no vitest heading, every error line) in the head's job log also fails there. A check that fails at another step, fails a test the base does not, or whose step or log cannot be read, wakes the fixer.
