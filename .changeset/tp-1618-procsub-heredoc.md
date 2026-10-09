---
"@titan-design/tool-guard": patch
---

Read a heredoc left open by a `$( )` or `<( )` both ways. Bash 5 reads its body from the lines after the substitution closes and bash 3.2 does not, so a quote in the body could open a word that swallowed a later `git push`. At the newline that ends the line, the lexer now also reads the text bash 5 runs after every pending body, taking them in bash 5's order: each substitution's heredocs as it closed, then the line's own. That way a later heredoc or a second substitution on the line cannot move where that text starts. The extra text is charged by length. When that budget is spent, or when either reading fails to parse, the line is refused with a reason that names the open heredoc.
