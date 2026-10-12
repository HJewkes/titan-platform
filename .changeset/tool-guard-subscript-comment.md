---
"@titan-design/tool-guard": patch
---

Refuse a line when a `#` comment or `<<` heredoc opener falls inside a `NAME[ … ]` subscript that bash may join but the guard splits, so neither reading can hide a following `git push` (TP-2443).
