---
"@titan-design/tool-guard": patch
---

The lexer reads bash's and zsh's `{name}<`, `{name}<>` and `{name}<&` as a redirect whose fd the line cannot number, not as an operand. A shell that runs `/dev/fd/N` or `/proc/self/fd/N` with N from 10 up after such a redirect is refused, so `bash {fd}< ./x.sh /dev/fd/10` no longer passes.
