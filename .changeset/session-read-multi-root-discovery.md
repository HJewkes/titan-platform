---
"@titan-design/session-read": minor
---

Add `claudeTranscriptRoots` and `discoverAllTranscripts` for discovery across `~/.claude` and every `~/.claude-profiles/<name>` that has a `projects` dir, overridable with `CLAUDE_CONFIG_DIRS` (TP-259). `DiscoveredTranscript` gains an `account` field, `"default"` for the default root and the profile directory name otherwise, `null` when returned by `discoverTranscripts(root)` directly. `transcriptsRoot()` and `discoverTranscripts(root)` behavior is unchanged.
