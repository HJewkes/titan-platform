---
"@titan-design/tool-guard": patch
---

Walk the text of zsh's `emulate [-lLR] [{+|-}o opt]... [mode] -c TEXT` as `eval` text, so `emulate zsh -c 'git push origin HEAD:main'` is denied like the push it runs (TP-3207).
