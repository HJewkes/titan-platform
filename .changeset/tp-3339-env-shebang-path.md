---
"@titan-design/tool-guard": patch
---

Refuse a by-path script whose `#!` is `/usr/bin/env bash|sh|zsh` when the same line changes PATH, since env then finds its shell through the new PATH.
