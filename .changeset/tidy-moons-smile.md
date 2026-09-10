---
"@titan-design/locator": minor
"@titan-design/session-graph": patch
---

Detect a rotation that did not shrink the file, and purge when the extractor rewinds itself.

`resumePoint` now treats "same length as the watermark, but a newer mtime" as grounds to
hash the prefix without being asked, since transcripts only grow. The cost lands on the
few files that look wrong rather than on every file every pass, which is what makes
`verifyHash` too expensive to leave on. `TranscriptEntry` gains an optional `mtime`;
omitting it keeps the previous behaviour exactly.

`indexTranscript` now honours `extractTranscript`'s `restartedFromZero`. The extractor
re-hashes the prefix it was asked to skip and restarts from byte 0 when the bytes moved,
and that answer was being discarded: the whole file replayed onto rows that were never
removed, which is the accumulation `purgeTranscript` exists to prevent, reached by a
different road.
