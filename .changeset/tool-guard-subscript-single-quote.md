---
"@titan-design/tool-guard": patch
---

Read a single quote in an assignment subscript (`a['$(c)']=1`, `x[ '$(c)' ]=1`, `declare a[...]=1`, an element of `NAME=( … )`) and in a `[[ … -eq … ]]` test as bash does, like a double quote, so a `$( )` or backtick inside is walked and refused (TP-3353).
