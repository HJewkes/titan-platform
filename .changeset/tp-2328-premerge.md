---
"@titan-design/github": minor
---

Add `titan-gh premerge <owner/repo#N> <sha> --approved-head <sha> [--clone <dir>] [--json]`: the read-only half of agent-chat's `scripts/seat/premerge`. It checks PR state, the head sha, required checks and statuses, strict behind and the approved-head walk, and prints `OK ... head= base= req=[] strict= behind=` or `FAIL <repo>#<N>: <reasons>`, exiting 0, 1, or 2 on usage. With `--clone`, the bin runs `git merge-tree --write-tree` in that clone to prove a walked approval and to merge the head into the base branch's current tip, read from GitHub and passed by sha (never a local, possibly stale `origin/<base>`), failing on a conflict, a git error or a clone without that commit. Without it, an approved head other than the PR head fails, and GitHub's `unknown` mergeability is re-read a few times and then fails, never passes. `PullRequest` gains an optional `behindBy`, which `getPr` fills from the compare for an open PR.
