---
"@titan-design/tool-guard": patch
---

Refuse a command whose process substitution opens a heredoc with its body outside the `<( )` or `>( )`. Bash 5 reads that body from the lines after it and bash 3.2 does not, so a quote in the body could open a word that swallowed a later `git push`. The lexer now throws `ParseError` there, which fails closed.
