---
"@titan-design/tool-guard": patch
---

Track `NAME+=value` appends (plain and through `declare`/`typeset`/`local`/`export`) and `printf -vNAME`, so `Y=pu; Y+=sh; git $Y origin HEAD:main` and `X=status; printf -vX push; git $X origin HEAD:main` classify as pushes to main. An append is literal only when both parts are; otherwise the variable is unknown.

`printf -v` is read only as the first argument, so `printf -- -vX` and `printf '%s\n' -vX` leave X alone. An array assignment (`Y=(pu sh)`) sets `$Y` to its element 0 when that is plainly literal, and makes it unknown when a brace, glob or `[i]=` element could change it; an array append (`Y+=(sh)`) keeps a known `$Y` and leaves an unset one unknown.

Inside a function body, `local`, `declare` and `typeset` (without `-g`) make a new local, so `NAME+=value` there starts from empty, as bash does: `Y=status; f() { local Y+=push; git $Y origin HEAD:main; }; f` classifies as a push to main. A `{ }` function body's locals take back their outer value at the closing brace, so `Y=push; f() { local Y=status; }; f; git $Y origin HEAD:main` is a push to main (TP-1473). The outer value is saved in a slot whose name is no shell identifier, so user code cannot overwrite it, and a local inside a nested `( )` subshell is left to that subshell. A case pattern's parentheses no longer end a `( )` function body, and `esac` ends the case wherever it stands, so a pipe after an empty case is still a pipe. A push inside a `function f { ...; }` body is no longer read as arguments of `function`.
