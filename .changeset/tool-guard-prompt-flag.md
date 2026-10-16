---
"@titan-design/tool-guard": patch
---

The shell lexer refuses a zsh `${(%%)x}` expansion (two `%` flags in one group) as running its value; a single `%` and a `%%` inside a flag argument stay allowed.
