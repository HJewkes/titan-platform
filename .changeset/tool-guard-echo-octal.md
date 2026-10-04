---
"@titan-design/tool-guard": patch
---

Decode `echo -e` and `printf %b` octal as `\0nnn`, and stop at `\c`, so `echo -e '\0147it push' | sh` is read as `git push`. A printf format string keeps the `$'...'` `\nnn` rule.
