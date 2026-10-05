---
"@titan-design/tool-guard": patch
---

The shell lexer keeps a subscript assignment with blanks inside the brackets as one word, as bash does: `Y[ 0 ]=x git push origin HEAD:main` now yields the git push, and `Y[ 0 ]=push` before `git $Y` counts as a write to `Y`. This applies only where an assignment may stand and only when `=` or `+=` follows the `]`. `[ 0 ]`, `echo Y[ 0 ]`, an unclosed bracket, and a bracket with no `=` after it lex as before.
