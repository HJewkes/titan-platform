---
"@titan-design/tool-guard": patch
---

The lexer reads bash's `{name}<` and `{name[i]}<`, and zsh's `{name} <` a space apart, as a redirect that may store a descriptor from 10 up, not as an operand. A shell that runs `/dev/fd/N` or `/proc/self/fd/N` with N from 10 up after one is refused, and so is any shell command that carries one, since dash keeps `{name}` as its script. `bash {fd}< ./x.sh /dev/fd/10` no longer passes.
