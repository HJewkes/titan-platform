---
"@titan-design/tool-guard": patch
---

Refuse a line with a zsh expansion that runs its value, such as `${~x}`, `$~x` and `${(e)x}`, whether at the top level, nested in `${ }` or `$(( ))`, or in an unquoted heredoc body (TP-2937).
