---
"@titan-design/tool-guard": patch
---

The shell lexer refuses a heredoc opener (`<<`, `<<-`, `<<<`) inside `[[ ]]`. Bash reads extglob there with no shopt, so in `[[ x == @(]]<<E) ]]` the opener is pattern text, bash registers no heredoc, and the lines after it run while the guard read them as a heredoc body. `[[ a < b ]]` stays allowed.
