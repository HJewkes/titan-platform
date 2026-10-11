---
"@titan-design/github": minor
---

Add `titan-gh premerge <owner/repo#N> <sha> --approved-head <sha> [--clone <dir>] [--json]`: the read-only half of agent-chat's `scripts/seat/premerge`. It checks PR state, the head sha, required checks and statuses, strict behind and the approved-head walk, and prints `OK ... head= base= req=[] strict= behind=` or `FAIL <repo>#<N>: <reasons>`, exiting 0, 1, or 2 on usage. With `--clone`, the bin proves a walked approval with `git merge-tree --write-tree` in that clone; without it, an approved head other than the PR head fails. `PullRequest` gains an optional `behindBy`, which `getPr` fills from the compare for an open PR.
