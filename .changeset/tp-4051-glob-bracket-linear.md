---
"@titan-design/tool-guard": patch
---

Compiling a glob with many unterminated `[` no longer searches to the end of the word for each one, so a script word full of `$${x[` openers costs linear work instead of quadratic (TP-4051).
