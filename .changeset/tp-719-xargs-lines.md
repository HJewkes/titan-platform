---
"@titan-design/tool-guard": patch
---

`xargs -I` now runs its command once per input line, so a push on a later line of piped text, a here-string or a heredoc is classified as a push. A line that is only the replace string is read as shell words.
