---
"@titan-design/tool-guard": patch
---

Add an internal reader, `namesGlobSubstOption`, for whether a command names zsh's GLOB_SUBST (`setopt`, `unsetopt`, `set -o`, `emulate`, `zsh`, and an argv0 that makes zsh emulate sh or ksh), and an `argv0` field on the unwrapped command (TP-3174, slice e of TP-2938).
