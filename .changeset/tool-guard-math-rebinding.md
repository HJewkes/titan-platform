---
"@titan-design/tool-guard": patch
---

Refuse math that may store into a command-rebinding parameter (`commands`, `BASH_CMDS`, `functions`, `dis_functions`, `nameddirs`), as `e='commands[y]=0'; shift "$e"` does in zsh: a shift count, `let` operand, `(( ))` body, `$(( ))` or `$[ ]` body, and an array subscript are all evaluated as arithmetic, which assigns. A literal store (`let 'commands[y]=0'`) is refused, and so is a run-time word in those places, since it may expand to one. An fd-variable redirect into a rebinding parameter (`{BASH_CMDS[y]}>f`) is refused too. The names come from one list shared with `PROTECTED`.

Numeric math on ordinary names still passes: `shift $((OPTIND-1))`, `(( i++ ))`, `let n=n+1`, `exec {fd}>log`, and expansions that yield numbers (`$#`, `$?`, `$$`, `$!`, `${#x}`, `${#a[@]}`, zsh `$+x`).

Math also reads a bare name as the math its value holds, so a name the same line set to a store (`X='commands[y]=0'; (( X ))`, `shift X`, `let X`, `${a[X]}`) is refused, and so is a name set to a value the guard cannot read (`X=$(cat f); (( X ))`, `read X; (( X ))`). A name only arithmetic wrote, or `OPTIND` after `getopts`, holds a number and passes. A `<` or `>` inside `(( ))` is read as part of the math, so `(( i < $e ))` and `for ((i=0;i<$e;i++))` are checked too.

Accepted false positives, all refused because the run-time word may hold a store: a run-time word in a `let`, `(( ))`, `$(( ))` or `$[ ]` body (`(( i < $n ))`, `echo $(( $a + $b ))`, `$(( ${x:-1} + 2 ))`); a bare name in math that the line set from a command substitution, a default expansion or `read` (`n=$(wc -l f); (( n > 0 ))`); a run-time word in a `shift`, `repeat`, `return`, `exit`, `break` or `continue` operand (`exit "$rc"`); a run-time subscript on an element read or an unquoted element assignment (`${arr[$i]}`, `arr[$i]=x`), even on an associative array; an assignment inside `(( ))` of a run-time value (`(( x = $1 ))`); a math text over 1024 characters.

Not covered here: numeric `[[ -eq ]]` operands, `declare -i` values and quoted name arguments to name-taking builtins (`unset 'a[$e]'`).
