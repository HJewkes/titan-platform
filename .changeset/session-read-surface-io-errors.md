---
"@titan-design/session-read": minor
---

Discovery and readback now separate absence from failure. These calls can now reject on an I/O error other than a missing path (for example `EACCES` or `EMFILE`) where they used to return an empty or null result:

- `discoverTranscripts`, `discoverAllTranscripts` and `discoverCodexSources` reject instead of returning `[]` or skipping the directory. A missing directory, or a stray file beside the project directories, still reads as no transcripts.
- `claudeTranscriptRoots` throws when `~/.claude-profiles` or a profile's `projects` path cannot be inspected; a missing one is still skipped.
- `readClaudeText`, `readCodexText` and `readSessionSourceText` reject instead of returning `null`. They still return `null` for a stale locator: the file is gone or shorter than the span, or the line no longer matches its hash, decodes as UTF-8 or parses as JSON.

`codexHome()` now honors `CODEX_HOME` when it is set and non-empty, as the Codex CLI does, so `discoverCodexSources({ namespace })` without an explicit `codexHome` scans the same directory Codex writes to.
