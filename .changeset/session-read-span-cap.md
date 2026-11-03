---
"@titan-design/session-read": minor
---

`extractTranscript` and `readTranscriptEvents` take a `spanTextCap` read option, the chars kept per span. The default stays `SPAN_TEXT_CAP` (16 KiB), which bounds the search index; a caller that parses a span, such as an agent's final JSON answer, passes `Infinity` to read it whole.
