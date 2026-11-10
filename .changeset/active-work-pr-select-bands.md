---
"@titan-design/active-work": patch
---

PR outcome polling now orders its batch in three bands, matching session-graph: never-checked PRs, then due open or closed PRs, then merged PRs that only lack commit times. Within a band the least recently checked go first, then by PR ref. A backlog over the cap no longer lets commit-times backfill crowd out due open PRs.
