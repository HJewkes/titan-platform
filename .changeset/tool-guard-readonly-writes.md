---
"@titan-design/tool-guard": patch
---

The variable tracker now honours readonly variables. A variable made readonly by `readonly`, or by `declare`, `typeset` or `local` with an `r` option, keeps its value when a later plain or element assignment, `read`, `printf -v`, `mapfile`, `unset`, `for` or declaration tries to write it, as bash does. A readonly array assignment (`declare -ra`, `readonly -a`) leaves the value unknown, because bash 3.2 rejects it and bash 5 does not. A variable that only may be readonly becomes unknown on a write: after a function returns from a `local -r`, inside `eval` or a child shell, or after a declaration word known only at run time.
