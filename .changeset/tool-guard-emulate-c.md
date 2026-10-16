---
"@titan-design/tool-guard": patch
---

Walk the text `emulate MODE … -c TEXT` runs as `eval` text, so a guarded command behind `emulate zsh -c '…'` is classified. Option words are read as zsh's own lexers read them, so every cluster zsh takes `c` from (`+c`, `-xc`, `-c2`, `-2c`, `-c-`, `-co NAME`) reaches the text, and a dynamic word may be `-c` (TP-3207).
