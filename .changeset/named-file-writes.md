---
"@titan-design/tool-guard": patch
---

A file that `tee`, `cp`, `mv`, `install`, `dd of=` or `ln` writes by name is now read as the line may leave it, so `echo git push origin HEAD:main | tee real.sh; bash real.sh` and `cp evil.sh real.sh; bash real.sh` are refused. A copy takes its source's readings, into the target and into `<target>/<source name>` when the target may be a directory; `tee`, `ln -s`, a partial `dd`, and a tree copy leave the target untracked, and a dynamic target leaves every file untracked (TP-3361).
