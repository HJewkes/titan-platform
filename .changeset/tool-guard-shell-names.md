---
"@titan-design/tool-guard": patch
---

Read a zsh `=NAME` command word as NAME, and a restricted or versioned shell name (`rzsh`, `rbash`, `rksh`, `zsh5`, `bash5.2`) as its base shell, so a guarded command behind `=zsh -c '…'` or `zsh5 -c '…'` is classified. `rsh` stays the remote shell (TP-3208).
