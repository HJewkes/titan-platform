---
"@titan-design/tool-guard": patch
---

`definesAlias` reads zselect's `-r`/`-w`/`-e` as flags and its options after an fd, and refuses stores into an alias parameter through `syswrite -c`, `sysopen -u`, `syserror -e`, `zsystem flock -f`, `zgetattr`, `zlistattr`, `zpty -r`, `zregexparse` and `zcurses` (TP-2793).
