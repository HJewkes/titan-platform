---
"@titan-design/tool-guard": patch
---

The shell lexer marks the first `(` of a `((` it reads as an arithmetic command with `arith: true`. The token shape is unchanged and nothing reads the marker yet.
