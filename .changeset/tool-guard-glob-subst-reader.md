---
"@titan-design/tool-guard": patch
---

Add an internal reader, `namesGlobSubstOption`, for whether a command names zsh's GLOB_SUBST (`setopt`, `unsetopt`, `set -o`, `emulate`, `zsh`, `rzsh`, and an argv0 that makes zsh emulate sh or ksh, also inside an `env -S` script; a command word or argv0 that is dynamic or may expand reads as naming it), and an `argv0` field on the unwrapped command (TP-3174, slice e of TP-2938).
