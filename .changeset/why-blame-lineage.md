---
"@titan-design/session-graph": minor
"@titan-design/active-work": minor
---

`why <path>:<line>[-<end>]` runs `git blame -L` at HEAD and maps each commit to its PR (the squash subject's `(#n)`), the tasks behind it and the sessions that did the work, printing the rung that found each: `trailer`, `pr-subject`, `pr-task`, `refs`, `session-ran`. An `Agent-Session:` trailer is read first. Sessions and tasks in an initiative the caller may not see are counted in `hidden`, never named. session-graph exports the walk as `commitLineage` (TP-2771).
