---
"@titan-design/tool-guard": patch
---

Read `&&` and `||` inside `[[ ]]` as words of that one command, but only when the `[[` is the first word of a line or follows a control operator (`;` `&` `&&` `||` `|` `|&`, newline, an opening `(`). Every other `[[` keeps the split reading, so `[[ -n $x && $y == z ]] # c` no longer reads as a command with a dynamic name, and nothing after a prefix word can hide a command inside a `[[`.

Joining is opt-in: `extractCommands` splits unless called with `joinsConditional: true`, which `classify` passes only for the Bash tool's own line. A script file never joins, since `sh x.sh`, `sh < x.sh` and a `#!/bin/sh` line run it as sh. A `-c`, heredoc or piped text joins only under bash, zsh or ksh with plain options (`-c`, `-e`, `-f`, `-n`, `-s`, `-u`, `-v`, `-x`), and no text joins when its line sets or exports `BASH_ENV`, `ENV`, `ZDOTDIR` or `HOME`, or names a shell beside any other option word.
