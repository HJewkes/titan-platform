---
"@titan-design/tool-guard": patch
---

The lexer reads a single quote, `$'` and `$"` inside an arithmetic command `(( ))`, `$(( ))`, `$[ ]` or a `${ }` as bash and zsh do: a quote that expands like a double quote, so a `$( )` or backtick in it is found and denied instead of passing as quoted text. Quotes outside those contexts read as before.
