---
"@titan-design/tool-guard": patch
---

Refuse a redirect or any operator but `)` inside a compound assignment's `( … )`. Bash rejects `a=( x <<E )` and `a=( x ; ) <<E` as syntax errors, so it registers no heredoc and runs the lines after it. The guard used to read those lines as heredoc body and let a push through.

`NAME=(` inside `(( ))` or a `[[ … =~ … ]]` operand is a group, not an array, and is still allowed. A redirect inside a `=~` operand's parens, which bash reads as regex text, is now refused.
