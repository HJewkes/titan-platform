---
"@titan-design/tool-guard": patch
---

Read the stdin text of a shell whose script operand is a plain path as a script too, since a cwd the line does not show or a symlink or move made earlier on it can make that operand the shell's own stdin (`ln -sf /dev/stdin real.sh; bash real.sh <<< T`, `cd "$D" && bash stdin <<< T`) (TP-3240).
