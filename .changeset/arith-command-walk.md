---
"@titan-design/tool-guard": patch
---

The walk reads a marked `((` as an arithmetic command only where bash or zsh is known to run the text: its words are no longer reported as commands, while substitutions inside it and spans that read as a command (`((git push))`) are still walked. `extractCommands` takes a new `arithmetic` option that defaults to false, so a caller that does not name the shell gets dash's nested-subshell reading and the commands inside are listed. A script is read as arithmetic only when bash or zsh runs it, its `#!` line names bash or zsh, or a bash or zsh line sources it.

A `#!` line counts as bash or zsh only when it is exactly `/bin/bash`, `/usr/bin/bash`, `/bin/zsh`, `/usr/bin/zsh`, or `env` with at most `-i` and `-S` before bash or zsh; any other env option reads as sh, so `(( ))` there is not arithmetic.
