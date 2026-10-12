---
"@titan-design/tool-guard": patch
---

Read a top-level or double-quoted `$[ ]` as arithmetic, so a `#` inside it no longer hides the rest of the line as a comment, and read `$"…"` as run-time text. The lexer and the balanced reader dispatch from one shared `$`-opener table, and an expansion opener the table does not list is refused. Every lookahead reads past the backslash-newlines bash drops before it reads a token, so `$\<NL>[`, `$a\<NL>b`, `$(\<NL>(`, `(\<NL>(`, `&\<NL>&`, `<\<NL><`, a subscript's `]\<NL>=` and an unquoted heredoc's `EO\<NL>F` delimiter line read as bash reads them.
