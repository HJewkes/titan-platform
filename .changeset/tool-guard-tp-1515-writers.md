---
"@titan-design/tool-guard": patch
---

Variable tracking now sees the writes `select`, `getopts`, `let` and `(( ))` make. `select NAME` and `getopts ... NAME` leave NAME unknown, and `getopts` also leaves `OPTARG` and `OPTIND` unknown. `let` and `(( ))` leave each name they assign unknown, and a `let NAME=<integer>` keeps the exact integer. A run-time expression may write any variable, so all tracked values become unknown. A surely readonly variable keeps its old value, as with a plain assignment. Before this change, `Y=status; select Y in push; do git $Y ...; done` still read as `git status`.
