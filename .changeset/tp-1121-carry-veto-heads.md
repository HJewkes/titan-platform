---
"@titan-design/factory": patch
"@titan-design/github": minor
---

Shepherd's seat check on a carried MERGE now reads seat reviewers at every commit the PR passed through since the reviewed head, not only the heads the run reviewed, so a FIX_FIRST at an unreviewed update refuses the carry. An unreadable or short commit list, or more than 50 heads, refuses too. `@titan-design/github` adds `listPrCommits` and `PR_COMMITS_CAP` to the port, wire and fake.
