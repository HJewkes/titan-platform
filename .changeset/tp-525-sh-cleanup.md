---
"@titan-design/factory": patch
---

`shepherd-pr` runs `sh-cleanup` after the main CI read. It deletes the merged head ref through the PR's head repo, so a fork head or the default branch is skipped. It marks the registration's task done only while active-work reports it open. It retires successors, the implementer and fresh reviewers, never the standing reviewer, no sooner than 3 minutes after exit and never with `--force`. Refusals past an hour end as caveats, not a failed run.
