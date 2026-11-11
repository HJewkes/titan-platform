---
"@titan-design/active-work": patch
---

Drive the mirror-root and bootstrap read-count tests through `CLAUDE_TRANSCRIPT_MIRRORS` and an `fs.promises.readFile` spy instead of internal module mocks.
