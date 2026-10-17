---
"@titan-design/tool-guard": patch
---

Walk zsh's `$( ( … ) )` reading of a `$(( ))` whose body holds a quote, so a command hidden behind a quoted paren is checked.
