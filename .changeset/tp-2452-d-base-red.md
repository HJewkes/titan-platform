---
"@titan-design/factory": patch
---

Shepherd: a ci-failed head whose every failing check also fails at the PR's base head wakes no fixer and spends no repair. The seat gets one `base-red` notice and the run waits in `sh-base-wait` until the base or the head moves, then refreshes the head and reads CI again. Unreadable base checks wake as before.
