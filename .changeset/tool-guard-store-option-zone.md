---
"@titan-design/tool-guard": patch
---

Refuse a run-time word where a builtin with a store option still reads options (`print $a`, `set $a`, `compgen $x`, `printf "$f"`), quoted or not, since it may expand to `-v commands[y]`; `print -- $x` passes. A run-time word in a name slot (`read -- "$n"`, `declare "$x"`) is refused after `--` too, for every builtin in `WRITER_SPECS`, the one table both name readers now share (`zpty -r z "$n"`, `zgetattr f a "$n"`, zsh `stat -H "$n"`). The option zone is derived from that table, with no exemptions, so zsh `stat` and `compadd` are in it: `stat "$f"` and `stat -- "$f"` are refused (zsh/stat skips one leading `--`), and `stat ./"$f"` passes. Both name readers now read past the one leading `--` that zsh skips for `zparseopts`, `zformat`, `zstyle`, `zstat` and `stat`, and both shells skip for `getopts`, so `zformat -- -f PS4 x` and `getopts -- o PS4` count as stores (TP-3320).
