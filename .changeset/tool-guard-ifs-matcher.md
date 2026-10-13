---
"@titan-design/tool-guard": patch
---

Add the shell IFS matcher (`namesIfs`, `ifsChanged`, `splittingWords`) that the walk will use to keep unquoted expansions raw once a line may have changed IFS. `namesIfs` reads lexed word values with braces expanded, so an escaped, quoted, continued, `$'…'` or brace spelling of IFS counts (TP-2723).
