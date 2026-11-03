---
"@titan-design/factory": patch
---

Add the old-path task tags reader and judge (TP-3182 S2a): a task id resolves to its initiative, `activeWorkTaskTags` reads one task's tags over the active-work loopback rpc with a timeout, and `judgeOldPath` turns a PR's files and its task into S1's freeze verdict, reading tags only when the PR touches a frozen root. Not yet wired into the merge guard.
