---
"@titan-design/session-read": patch
---

`commandHeads` drops a closing subshell paren glued to the last word, looks through `builtin` and `command` so `builtin cd x` is dropped like `cd x`, and the README documents that `command_heads` can keep lowercase positionals.
