---
"@titan-design/tool-guard": patch
---

Keep `$'` literal inside double quotes in the shell lexer, as bash does. Previously `echo "$'" ; git push origin HEAD:main ; echo "'"` decoded an ANSI-C string across the quotes and hid the push. ANSI-C decoding outside double quotes is unchanged.
