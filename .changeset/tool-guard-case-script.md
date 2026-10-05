---
"@titan-design/tool-guard": patch
---

Keep the `declare -l`/`-u` case mark through text `eval` and `sh -c` run, reading it as written, all lower and all upper case, and fold a marked command word the same way, so `declare -l G; G=GIT; $G push origin HEAD:main` reads as a git push.
