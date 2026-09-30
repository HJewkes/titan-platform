---
"@titan-design/session-analytics": patch
---

Classify agent-chat and git coordination calls in the default turn-action rules: `agent ls|budget|worktrees`, `git worktree list`, and the `agent_list`, `chat_list` and `ListAgents` tools are budget-status; `git merge-tree` is pr-ci-check; `chat_ask`, `chat_inbox`, `chat_claim` and `chat_release` are message. A bare `gh api` stays other.
