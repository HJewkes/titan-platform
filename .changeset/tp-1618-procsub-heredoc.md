---
"@titan-design/tool-guard": patch
---

Read a heredoc left pending by a process substitution both ways. Bash 5 takes its body from the lines after the `<( )` or `>( )` and bash 3.2 does not, so a quote in the body could open a word that swallowed a later `git push`. The lexer now classifies the substitution as before and also the text after the body, so that push is seen under either reading. Reading the second text is charged by length; once that budget is spent only the first reading is kept, which is what the lexer gave before.
