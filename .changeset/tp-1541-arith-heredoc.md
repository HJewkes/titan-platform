---
"@titan-design/tool-guard": patch
---

Read `<<` and `<<=` inside an arithmetic command `(( ))` as shift operators, not heredoc openers, so a command on the next line is no longer swallowed as heredoc body.
