---
"@titan-design/tool-guard": patch
---

Read NUL in text piped into zsh the way zsh does: each blank-delimited word ends at its first NUL, so `printf 'git\0xyz push origin HEAD:main\n' | zsh` classifies as a protected push. bash, sh and dash keep the NUL-dropped reading; ksh is read both ways.
