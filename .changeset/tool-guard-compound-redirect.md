---
"@titan-design/tool-guard": patch
---

Refuse a redirect inside a compound assignment's `( … )`. Bash rejects `a=( x <<E )` as a syntax error, so it registers no heredoc and runs the lines after it. The guard used to read those lines as heredoc body and let a push through.
