---
"@titan-design/session-read": minor
"@titan-design/session-graph": patch
---

Extract Claude Code transcript reading from active-work's session miner as a storage-free
event stream: `LineReader` (stateless per line, byte-offset locators), the `SessionEvent`
union, `EventFolder` with chunk-boundary-safe merge rules, `readTranscriptEvents` /
`extractTranscript` with prefix-hash resume, bash intent parsing, repo attribution, and
transcript discovery including subagent sidechains. `session-graph` is stamped as a placeholder.
