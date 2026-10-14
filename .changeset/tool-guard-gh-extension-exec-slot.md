---
"@titan-design/tool-guard": patch
---

`ghCommandLine` reads any `gh extension exec` path as a run-time slot whatever follows it (`--`, a flag's value, or nothing), as leak-guard does, so `ghPathUnknown` is true for `gh extension exec -- foo` and `gh ext exec -x foo`.
