---
"@titan-design/github": minor
"@titan-design/factory": patch
---

Add `jobSteps(repo, jobId)` to `GitHubPort` (wire: `getJobSteps`): an Actions job's steps in run order, each with its name and conclusion. The fake answers from `fake.jobSteps` and 404s a job with none seeded.

Shepherd's frozen-main and base-red holds now count a head's failing check as the base's only when it fails there at the same job step, and every failing test id (or, with no vitest heading, every error line) in the head's job log also fails there. A check that fails at another step, fails a test the base does not, or whose step or log cannot be read, wakes the fixer. So does one whose log may hold a failure it does not name: an unhandled error or worker crash, a tail cut inside vitest's failure output, headings that number other than the summary's failed tests and suites, or a step that timed out or was cancelled.
