---
"@titan-design/agent": minor
---

Add launch identity, per-agent TMPDIR and the orphan reap it depends on, ported from agent-chat: `withoutLaunchIdentity`, `ensureAgentTmpDir`, `removeOwnTmpDir`, `sweepAgentTmpDirs`, `reapOwnLaunch` and their process-table and filesystem seams.
