---
"@titan-design/tool-guard": patch
---

Track the `-l` and `-u` case attributes of `declare`, `typeset` and `local`. After `declare -l Y`, a later write to `Y` keeps its value only when the case leaves it as written; otherwise `Y` is unknown, so `declare -l Y; Y=PUSH; git $Y origin HEAD:main` no longer reads as `git PUSH`. Bash 3.2 has no case attributes, so the guard never applies the transform itself.

A push destination held by such an unknown variable, as in `declare -u B; B=main; git push origin HEAD:$B`, classifies as `bash.merge.git-push-protected` with branch `unknown`.
