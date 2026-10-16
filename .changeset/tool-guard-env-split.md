---
"@titan-design/tool-guard": patch
---

Split an `env -S` string into words by env's own rules (blanks, quotes, `#`, `${NAME}`) and read them as env's argv, so env's options at its head (`-u X`, `-a sh`, `-i`, `-C dir`, a nested `-S`) are no longer read as the command. A guarded command behind `env -S '-u X …'` is now classified. An `-S` string whose words cannot be known (an unclosed quote, a backslash, a dynamic word, or a `${NAME}` among env's options or as its command) is refused with its own reason, in a script file the line runs as well as on the line itself (TP-3210).
