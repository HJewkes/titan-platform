---
"@titan-design/tool-guard": patch
---

Read a shell's options as the shell reads them, so its `-c` text or script file is found: zsh's `--emulate MODE`, a cluster whose `o` or `O` takes the next word (`-eo pipefail`, `-co errexit TEXT`), zsh's `o` taking the rest of its cluster and its valueless `O`, a lone `-` ending the options, `-s` making the operands positional parameters, and a `/dev/stdin` script file. One reader now serves the `-c` walk and the script-file target (TP-3221).
