---
"@titan-design/factory": patch
---

Shepherd's review phase now dispatches a reviewer. A new `sh-review` step stamps `{head, reviewer, at}`, then spawns a fresh `rv-<repo>-<pr>` reviewer through a `ReviewerDispatch` port, or resumes the registration's opt-in reviewer when it has exited under 300k fill and the roster proves it independent of the implementer: no author of the code is the reviewer, spawned it, or handed over to it, at any depth. A roster row without a `predecessor` field proves nothing, so a port that stores no lineage always gets a fresh reviewer. The brief carries only the repo, PR and head. `reviewPhase` runs `sh-review`, then `sh-await-verdict`, and takes an accepted MERGE through `sh-merge-evidence`. With no dispatch wired the step answers `none` and the owner gate decides. A FIX_FIRST keeps at most 16,000 characters of the reviewer's message in the step output, cut at the end with a `[truncated]` marker.
