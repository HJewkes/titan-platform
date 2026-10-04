---
"@titan-design/tool-guard": patch
---

Variable tracking now sees subscripted writes. `Y[0]=push` and `declare 'Y[0]=push'` (also `typeset` and `local`) set `$Y` to the element-0 value. `export` and `readonly` reject a subscripted name, so they leave the variable unchanged. Any other subscripted write, `mapfile` and `readarray` make the variable unknown. An element assignment before a command is skipped as an assignment, so `Y[0]=x git push` is read as the git command.
