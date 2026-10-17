---
"@titan-design/tool-guard": patch
---

Read the `< file` feed of a shell whose literal script operand may name its own stdin (`cd /dev && bash stdin < x.sh`), so a push in that file is denied. A feed to an operand that is a regular file is data and is left alone.
