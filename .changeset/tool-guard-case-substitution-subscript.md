---
"@titan-design/tool-guard": patch
---

Treat a `case` word or a heredoc opener in a `$( )` inside a subscript as unsure, so a case pattern's `)` or a heredoc body's `)` no longer ends the substitution early and hides a command after a `#`.
