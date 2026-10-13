---
"@titan-design/tool-guard": patch
---

Refuse a redirect or any operator but `)` inside a compound assignment's `( … )`. Bash rejects `a=( x <<E )` and `a=( x ; ) <<E` as syntax errors, so it registers no heredoc and runs the lines after it. The guard used to read those lines as heredoc body and let a push through.
