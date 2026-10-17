---
"@titan-design/tool-guard": patch
---

Refuse a run-time word where a builtin with a store option still reads options (`print $a`, `set $a`, `compgen $x`, `printf "$f"`), quoted or not, since it may expand to `-v commands[y]`; `print -- $x` passes. The builtins and their manual sources sit in `STORE_OPTION_BUILTINS` (TP-3320).
