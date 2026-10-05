---
"@titan-design/tool-guard": patch
---

Classify a script piped into a shell from a `{ }` group, a `( )` subshell or a process substitution read as stdin (`bash < <(printf ...)`), with the same NUL readings a plain pipe gets.
