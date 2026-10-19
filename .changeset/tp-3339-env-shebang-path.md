---
"@titan-design/tool-guard": patch
---

Refuse a by-path script whose `#!` is `/usr/bin/env bash|sh|zsh` when the same line changes PATH, since env then finds its shell through the new PATH.

A PATH= or HOME= prefix on a function call, or on a special builtin that a POSIX-mode shell keeps it after, counts as a change to the whole line.

A PATH entry that a `$( )` or backquote lands in is never treated as fixed, and neither is a `~` or `$HOME` entry once the line may give HOME a value other than a fixed absolute directory.
