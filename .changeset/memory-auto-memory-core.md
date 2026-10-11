---
"@titan-design/memory": minor
---

Add the auto-memory core: `parseMemoryFile` and `parseMemoryIndex` read Claude Code auto-memory fact files and `MEMORY.md` indexes, `dedupeFacts` merges exact and same-polarity near-duplicate facts across projects, `groupFacts` groups them by topic, and `proposeDestination` proposes where each group should live. All are pure and deterministic, with no filesystem or model access.
