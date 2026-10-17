---
"@titan-design/tool-guard": patch
---

Refuse a Bash line that rebinds a command name (`hash y=/usr/bin/git; y push`, bash `hash -p`, stores into `commands`, `BASH_CMDS` or `functions`), with its own hook reason (TP-2706).
