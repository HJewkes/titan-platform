---
"@titan-design/session-read": minor
"@titan-design/session-graph": minor
"@titan-design/session-analytics": patch
---

Index transcripts mirrored from another host as children of the same session. session-read's `claudeTranscriptRoots` adds a root for each `<dir>/<account>/projects` named by `CLAUDE_TRANSCRIPT_MIRRORS` (`<host>=<dir>` entries), and `TranscriptRoot` and `DiscoveredTranscript` gain an optional `host`. When a session has facts in more than one transcript, session-graph's rollup recounts `turn_count`, `commit_count` and `push_count` without counting any copy twice. `purgeTranscript` on one copy keeps the shared session row, and the new `SIGNAL_COPY_RANK` export ranks the copies of a `session_signal` row. session-analytics episodes read each signal once.
