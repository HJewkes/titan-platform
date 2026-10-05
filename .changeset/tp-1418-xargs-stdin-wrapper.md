---
"@titan-design/tool-guard": patch
---

A command whose words come from stdin through `xargs` is now classified as a direct call is when `xargs` runs a wrapper such as `env`, `sudo`, `nohup`, `nice` or `timeout`: `echo gh pr merge 1 | xargs env` and `printf 'git\0push origin HEAD:main' | xargs -0 sudo` no longer slip past rules their direct forms hit.
