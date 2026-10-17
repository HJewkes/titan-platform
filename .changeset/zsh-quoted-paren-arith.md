---
"@titan-design/tool-guard": patch
---

Walk zsh's `$( ( … ) )` reading of a `$(( ))` whose body holds a quote, so a command hidden behind a quoted paren is checked.

Nesting of `$(( ))` read both ways is bounded across heredoc bodies, backquotes and quoted spans too, so such a line is refused in bounded time.
