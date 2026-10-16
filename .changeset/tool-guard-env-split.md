---
"@titan-design/tool-guard": patch
---

Split an `env -S` string into words by env's own rules (blanks, quotes, `#`, `${NAME}`) and read them as env's argv, so env's options at its head (`-u X`, `-a sh`, `-i`, `-C dir`, a nested `-S`) are no longer read as the command. A guarded command behind `env -S '-u X …'` is now classified. An `-S` string whose words cannot be known (an unclosed quote, a backslash, a dynamic word) is refused as a parse error (TP-3210).
