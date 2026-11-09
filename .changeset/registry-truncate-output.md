---
"@titan-design/registry": minor
---

Add `truncateOutput`, a byte-budget truncator for tool output. It keeps about 60 percent of the kept lines from the head and 40 from the tail around a `--- N lines omitted ---` marker, and falls back to a code-point cut when not even the first and last line fit. The output never exceeds `maxBytes` and `omittedLines` is never negative.
