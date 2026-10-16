---
"@titan-design/tool-guard": patch
---

Read a shell's options as the shell reads them, so its `-c` text or script file is found: zsh's `--emulate MODE`, a cluster whose `o` or `O` takes the next word (`-eo pipefail`, `-co errexit TEXT`), zsh's `o` taking the rest of its cluster and its valueless `O`, a lone `-` ending the options, `-s` making the operands positional parameters, and a `/dev/stdin` script file. One reader now serves the `-c` walk and the script-file target (TP-3221).

The reader follows bash's, zsh's and dash's own option lexers, proven against a table of real runs: `+c` is `-c`, zsh's digits are option letters (`-0`, `-c0`), zsh's lone `+`, trailing `-` and `b` end its options, bash's `s` reads stdin under either sign, and dash runs its stdin after a `-c` string under `-s`. Stdin script paths are matched however they are spelled (`//dev/stdin`, `/dev/./stdin`, `/proc/thread-self/fd/0`). `zshOptionWord` is the one zsh option-word lexer for the `emulate` builtin to share.
