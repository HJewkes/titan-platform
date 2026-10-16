---
"@titan-design/tool-guard": patch
---

Walk the text `emulate MODE … -c TEXT` runs as `eval` text, so a guarded command behind `emulate zsh -c '…'` is classified. The reader covers `+c`, `-xc`, `-co NAME`, a lone `-` and a dynamic word that may be `-c` (TP-3207).
