---
"@titan-design/tool-guard": patch
---

Variable tracking now treats a subscripted `read` or `printf -v` target (`read 'Y[0]'`) as writing the base variable, leaving it unknown, and no longer ends a `case` at an `esac` that is a parenthesised pattern (`(a|esac)`).
