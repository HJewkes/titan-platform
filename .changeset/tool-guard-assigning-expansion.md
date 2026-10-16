---
"@titan-design/tool-guard": patch
---

The lexer refuses a `${…}` that assigns while it expands (`:=`, `::=`, `=`) when its target is not a plain literal name the guard leaves alone: an indirect name (zsh `(P)`, bash `!`), a nested name (`${(P)${n}::=x}`), or a protected parameter (`options`, `commands`, `functions`, `PS4` and the other hooked or rebinding names, with any subscript). It reads the expansion at every `$` the lexer meets, so words, prefix assignments, redirect targets, here-strings, unquoted heredocs, arithmetic, `$( )`, backticks and `eval` text are covered, and a `$` that brace expansion may join to a later assigning `{…}` counts too (TP-3172, slice d of TP-2938).
