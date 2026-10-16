---
"@titan-design/tool-guard": patch
---

Read `&&` and `||` inside `[[ ]]` as words of that one command, so `[[ -n $x && $y == z ]]` no longer splits into a command with a dynamic name and a bogus `=` command.
