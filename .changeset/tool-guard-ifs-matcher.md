---
"@titan-design/tool-guard": patch
---

Add the shell IFS matcher (`namesIfs`, `ifsChanged`, `splittingWords`) that the walk will use to keep unquoted expansions raw once a line may have changed IFS (TP-2723).
