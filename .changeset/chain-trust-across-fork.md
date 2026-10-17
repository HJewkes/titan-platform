---
"@titan-design/tool-guard": patch
---

A branch created before a `{name}` redirect that the shells read two ways stays trusted for the rest of its `&&` chain, so `git checkout -b feat && A=1 {fd}< /dev/null && git merge feat` is no longer refused.
