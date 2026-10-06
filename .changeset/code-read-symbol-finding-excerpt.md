---
"@titan-design/code-read": patch
---

`finding.get` on a whole-node finding whose node is a symbol, such as a function-length
metric finding, now returns the symbol's span as `finding.range` and excerpts and
highlights those lines with `context_lines` either side, instead of the first 80 lines of
the declaring file.
