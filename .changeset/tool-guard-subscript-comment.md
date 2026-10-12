---
"@titan-design/tool-guard": patch
---

Refuse a line when a `#` comment or `<<` heredoc opener falls inside a bare `NAME[ … ]` subscript the guard does not join, in any position, through the matching `]` or to the end of the source when the bracket scan cannot be sure where bash closes it (TP-2443). Bash 5.3 funsubs (`${ cmd; }`, `${⏎cmd⏎}`) are not read yet; that is TP-2517.
