---
"@titan-design/session-read": patch
---

`findClaudeSessionSource` no longer reports a transcript unavailable when the cwd's project-directory name is longer than the filesystem allows for one name. It treats that exact path as absent and scans the project directories by session id, as it does for any other cwd whose directory Claude named differently.
