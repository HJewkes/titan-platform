---
"@titan-design/agent": patch
---

Pass `CLAUDE_CODE_REMOTE` through `prepareEnv`, so a child `claude -p` run can skip the CLI's subagent warmup.
