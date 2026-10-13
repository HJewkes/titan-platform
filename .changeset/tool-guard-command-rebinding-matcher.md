---
"@titan-design/tool-guard": patch
---

Add `rebindsCommand` and `CommandRebindingError`, which tell when a command binds a command name to another program (`hash y=/usr/bin/git`, bash `hash -p`, stores into `commands`, `BASH_CMDS`, `functions` or `nameddirs`), ahead of the guard refusing such lines (TP-2706).
