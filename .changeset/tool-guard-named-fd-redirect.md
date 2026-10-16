---
"@titan-design/tool-guard": patch
---

A `{name}` word before a redirect is read both ways the shells read it: bash's `{name}<` and `{name[i]}<` and zsh's `{name} <` take it as a descriptor from 10 up, while dash, and bash a space apart, keep it as a word. Each command carrying one is walked under both readings, and the line is refused if either is. `bash {fd}< ./x.sh /dev/fd/10`, `sh {run}< /dev/null` and `env -C {x} </dev/null git push origin HEAD:main` no longer pass.
