---
"@titan-design/tool-guard": patch
---

Expand getopt_long abbreviations for the options of timeout, nice, env, stdbuf, nohup, sudo, flock and watch, not only xargs, so `timeout --sig KILL 5 git push origin HEAD:main` no longer reads its value word as the command. An ambiguous prefix is read both ways.
