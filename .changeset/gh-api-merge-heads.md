---
"@titan-design/session-analytics": patch
---

The default turn-action rules now read the `gh api` heads session-read emits: `gh api PUT pulls/merge` is `merge`, and `gh api GET commits/check-runs` and `gh api GET commits/status` are `pr-ci-check`. The old merge pattern expected a pull number in the head, which session-read no longer keeps. Any other `gh api` head stays `other`.
