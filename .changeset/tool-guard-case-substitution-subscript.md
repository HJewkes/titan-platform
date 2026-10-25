---
"@titan-design/tool-guard": patch
---

Treat a `case` word or a heredoc opener in a `$( )` inside a subscript as unsure, and treat every `${ }` funsub or valsub body there as unsure too. A case pattern, a heredoc body or a comment no longer ends the substitution early and hides a command after a `#`.
