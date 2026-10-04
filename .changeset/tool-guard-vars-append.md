---
"@titan-design/tool-guard": patch
---

Track `NAME+=value` appends (plain and through `declare`/`typeset`/`local`/`export`) and `printf -vNAME`, so `Y=pu; Y+=sh; git $Y origin HEAD:main` and `X=status; printf -vX push; git $X origin HEAD:main` classify as pushes to main. An append is literal only when both parts are; otherwise the variable is unknown.

`printf -v` is read only as the first argument, so `printf -- -vX` and `printf '%s\n' -vX` leave X alone. An array assignment (`Y=(pu sh)`) sets `$Y` to its element 0 when that is plainly literal, and makes it unknown otherwise; an array append (`Y+=(sh)`) keeps a known `$Y` and leaves an unset one unknown.

Inside a function body, `local`, `declare` and `typeset` (without `-g`) make a new local, so `NAME+=value` there starts from empty, as bash does: `Y=status; f() { local Y+=push; git $Y origin HEAD:main; }; f` classifies as a push to main. A push inside a `function f { ...; }` body is no longer read as arguments of `function`.
