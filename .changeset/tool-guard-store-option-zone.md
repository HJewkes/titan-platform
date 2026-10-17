---
"@titan-design/tool-guard": patch
---

Refuse a run-time word where a builtin with a store option still reads options (`print $a`, `set $a`, `compgen $x`, `printf "$f"`), quoted or not, since it may expand to `-v commands[y]`; `print -- $x` passes. A run-time word in a name slot (`read -- "$n"`, `declare "$x"`) is refused after `--` too, for every builtin in `WRITER_SPECS`, the one table both name readers now share (`zpty -r z "$n"`, `zgetattr f a "$n"`, zsh `stat -H "$n"`). The builtins and their manual sources sit in `STORE_OPTION_BUILTINS` (TP-3320).
