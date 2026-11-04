---
"@titan-design/factory": patch
---

`shepherd status` now shows a post-merge run in `sh-cleanup` as "cleaning up after the merge: head branch, task and agents". Before, every post-merge step was shown as "watching main CI after the merge", so a run that had already read main CI as green and queued its redeploy looked stuck on main CI while cleanup waited for agents to exit.
