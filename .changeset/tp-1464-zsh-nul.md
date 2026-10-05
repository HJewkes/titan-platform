---
"@titan-design/tool-guard": patch
---

Read NUL in text a shell reads on stdin the way zsh does: zsh keeps it in the stream and cuts a word at it only where the word reaches an external program, so `printf 'git\0xyz push origin HEAD:main\n' | zsh` classifies as a protected push, and `eval`, assignments, here-strings and printed text carry the NUL on. bash, sh and dash keep the NUL-dropped reading; zsh and ksh are read both ways.
