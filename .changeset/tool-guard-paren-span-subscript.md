---
"@titan-design/tool-guard": patch
---

A balanced `$( )` or `$(( ))` inside a subscript (`a[$(( ${#a[@]} + 1 ))]=x # c`, `[ -z $(grep -c [0-9] f) ] # c`) no longer makes the line a false deny: the span scan reads it as self-contained when its body keeps to word characters, pipes and parens, holds no `case` word and keeps its brackets balanced.
