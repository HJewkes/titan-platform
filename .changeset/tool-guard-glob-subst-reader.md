---
"@titan-design/tool-guard": patch
---

Add an internal reader, `namesGlobSubstOption`, for whether a command names zsh's GLOB_SUBST (`setopt`, `unsetopt`, `set -o`, `emulate`, `zsh`, and an argv0 that makes zsh emulate sh or ksh). It reads the command word's shape from the literal-word boundary: a literal word as typed, a word that may become several words as naming it, and a double-quoted single-word `$NAME` by reading its arguments as every option-setting builtin (TP-3209, slice e2 of TP-2938).
