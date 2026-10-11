---
"@titan-design/github": minor
"@titan-design/factory": patch
---

`PullRequest` now carries `autoMerge`, read from the REST `auto_merge` field. Shepherd's `shepherd/review` publish reads it, so a PR with auto-merge armed gets `action_required` rather than `success`; an unreadable PR is treated as armed.
