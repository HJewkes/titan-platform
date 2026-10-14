---
"@titan-design/tool-guard": patch
---

Add an internal `mayEnableGlobSubst` matcher that reads whether a command may turn on zsh GLOB_SUBST (`setopt`/`unsetopt` in any spelling, `set -o`, non-zsh `emulate`, `zsh -o`/`--glob-subst`, writes to `$options`, run-time operands) (TP-2938 a). Not wired into the hook yet.
