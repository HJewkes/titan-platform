---
"@titan-design/tool-guard": patch
---

Add an internal boundary, `literalValue` and `commandWordShape`, for whether a word reaches a program as typed or is first rewritten or run by zsh (brace and glob expansion, `=NAME`, `~name`, `$=x`), `env -S` string splitting by env's own rules, and an `argv0` field on the unwrapped command that reads `exec -a`, `env -a`/`--argv0`, `env -S` and `ARGV0=` (TP-3206, slice e1 of TP-3174).
