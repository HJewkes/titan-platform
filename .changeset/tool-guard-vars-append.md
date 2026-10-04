---
"@titan-design/tool-guard": patch
---

Track `NAME+=value` appends (plain and through `declare`/`typeset`/`local`/`export`) and `printf -vNAME`, so `Y=pu; Y+=sh; git $Y origin HEAD:main` and `X=status; printf -vX push; git $X origin HEAD:main` classify as pushes to main. An append is literal only when both parts are; otherwise the variable is unknown.
