---
"@titan-design/tool-guard": patch
---

Read every command-rebinding store through the one store reader, `writesProtectedParam`, instead of a second builtin table. `hash`, `functions -c` and nameref declarations keep their own rules. Stores the old table missed, such as `strftime -s commands[y] 0`, `zstat -A commands f`, `sysread functions`, `pcre_match -v commands x` and `zselect -a commands`, now count as rebinding a command name.
