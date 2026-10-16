---
"@titan-design/tool-guard": patch
---

Read `&&` and `||` inside `[[ ]]` as words of that one command, but only when the `[[` is the first word of a line or follows a control operator (`;` `&` `&&` `||` `|` `|&`, newline, an opening `(`). Every other `[[` keeps the split reading, so `[[ -n $x && $y == z ]] # c` no longer reads as a command with a dynamic name, and nothing after a prefix word can hide a command inside a `[[`.
