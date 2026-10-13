---
"@titan-design/tool-guard": patch
---

The shell lexer refuses a `(` bash rejects (after a word outside command position, after a closer or redirect, `f ( x )`, `echo ( ) x`) or may read as an extglob pattern (`@(`, `!(`, `?(`, `*(`, `+(`), and a redirect between a function header and its body. Bash registers no heredoc there, so the lines after it could hide from the guard.
