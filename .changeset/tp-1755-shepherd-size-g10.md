---
"@titan-design/factory": patch
---

Shepherd sizes a PR before it spawns the reviewer: over 400 changed lines, generated registry files left out, the PR gets the g10 profile. `shepherd.review.g10ChangedLines` overrides the limit. A size it cannot read (truncated list, missing counts, failed read) takes the g10 profile.
