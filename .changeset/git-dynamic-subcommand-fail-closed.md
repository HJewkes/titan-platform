---
"@titan-design/tool-guard": patch
---

Fail closed on a git command whose subcommand word is dynamic. `git $Y origin HEAD:main` with `Y` unknown now classifies as `bash.merge.git-push-protected` with branch `unknown` (and an unknown egress destination) instead of no guarded action. `git "$Y" status` is an accepted false positive.
