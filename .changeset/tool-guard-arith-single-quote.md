---
"@titan-design/tool-guard": patch
---

The lexer reads a single quote inside an arithmetic command `(( ))` as a literal character, as bash and zsh do, so a `$( )` or backtick in it is found and denied instead of passing as quoted text. Single quotes outside `(( ))` read as before.
