---
"@titan-design/tool-guard": patch
---

Refuse math that may store into a command-rebinding parameter (`commands`, `BASH_CMDS`, `functions`, `dis_functions`, `nameddirs`), as `e='commands[y]=0'; shift "$e"` does in zsh: a shift count, `let` operand, `(( ))` body, `$(( ))` or `$[ ]` body, and an array subscript are all evaluated as arithmetic, which assigns. A literal store (`let 'commands[y]=0'`) is refused, and so is a run-time word in those places, since it may expand to one. An fd-variable redirect into a rebinding parameter (`{BASH_CMDS[y]}>f`) is refused too. The names come from one list shared with `PROTECTED`.

Numeric math on ordinary names still passes: `shift $((OPTIND-1))`, `(( i++ ))`, `let n=n+1`, `exec {fd}>log`, and expansions that yield numbers (`$#`, `$?`, `$$`, `$!`, `${#x}`, `${#a[@]}`, zsh `$+x`).

Accepted false positives, all refused because the run-time word may hold a store: a run-time word in a `let`, `(( ))`, `$(( ))` or `$[ ]` body (`(( i < $n ))`, `echo $(( $a + $b ))`, `$(( ${x:-1} + 2 ))`); a run-time word in a `shift`, `repeat`, `return`, `exit`, `break` or `continue` operand (`exit "$rc"`); a run-time subscript on an element read or an unquoted element assignment (`${arr[$i]}`, `arr[$i]=x`), even on an associative array; an assignment inside `(( ))` of a run-time value (`(( x = $1 ))`); a math text over 1024 characters.

Not covered here: numeric `[[ -eq ]]` operands, `declare -i` values and quoted name arguments to name-taking builtins (`unset 'a[$e]'`).
