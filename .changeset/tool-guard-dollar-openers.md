---
"@titan-design/tool-guard": patch
---

Read a top-level or double-quoted `$[ ]` as arithmetic, so a `#` inside it no longer hides the rest of the line as a comment, and read `$"…"` as run-time text. The lexer and the balanced reader dispatch from one shared `$`-opener table, and an expansion opener the table does not list is refused. Backslash-newlines after a `$` and inside a variable name are joined as bash joins them, so `$\<NL>[` and `$a\<NL>b` are read as `$[` and `$ab`.
