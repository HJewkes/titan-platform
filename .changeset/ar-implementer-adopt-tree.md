---
"@titan-design/agent-dispatch": minor
"@titan-design/factory": patch
---

`DispatchRequest` takes an optional `worktree`, passed to `agent-chat agent spawn` as `--worktree` so the agent adopts that path. Autoresearch implementers now adopt the engine's idea tree, which sits at the ratchet head, instead of working in a fresh worktree cut from the clone's default branch, and an exploit lane no longer moves a tree the agent already sits in.
