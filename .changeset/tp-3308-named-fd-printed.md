---
"@titan-design/tool-guard": patch
---

A `{name}` redirect's per-shell readings now decide the text a command prints into another, not only the command run: a `{ }` group or `( )` subshell piped on carries every reading's text, `$(...)` output is read as bash or zsh splices it, and a `< <(...)` whose readings print different text is left unknown. `{ echo {fd}</dev/null git push origin HEAD:main; } | bash` and `eval "$(echo {x} </dev/null git push origin HEAD:main)"` are refused.
