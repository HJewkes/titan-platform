---
"@titan-design/tool-guard": patch
---

Variable tracking now sees subscripted writes. `Y[0]=push` and `declare 'Y[0]=push'` (also `typeset` and `local`) set `$Y` to the element-0 value. `export` and `readonly` reject a subscripted name, so they leave the variable unchanged. An element declared with `-r` makes the variable unknown. A word known only at run time passed to `export`, `declare`, `typeset`, `local` or `readonly` can be any assignment, so it makes every tracked variable unknown, `HOME` included. So does any option letter except those that assign the value as written in bash 3.2 and 5 alike (`a i r t x` for `declare`, `typeset` and `local`, `n` for `export`, `a` for `readonly`), such as `declare -f`, `declare -l`, `declare -Q` or the glob `-[r]`. Any other subscripted write, `mapfile` and `readarray` make the variable unknown. An element assignment before a command is skipped as an assignment, so `Y[0]=x git push` is read as the git command.
