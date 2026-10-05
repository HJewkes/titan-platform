---
"@titan-design/tool-guard": patch
---

Track the `-l` and `-u` case attributes of `declare`, `typeset` and `local`. A value such an attribute may change is still read as written, which is what bash 3.2 runs, and the word it expands into is marked. A marked git subcommand or push destination classifies as `bash.merge.git-push-protected` with branch `unknown`, so `declare -l Y; Y=PUSH; git $Y origin HEAD:main` and `declare -u B; B=main; git push origin HEAD:$B` are protected. The secret family checks a marked argument as written and in both cases. The mark survives copies into other variables and word copies such as `xargs -I`.
