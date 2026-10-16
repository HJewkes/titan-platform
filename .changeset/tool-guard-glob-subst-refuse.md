---
"@titan-design/tool-guard": patch
---

The hook denies a Bash command that may turn on zsh `GLOB_SUBST` (an option name spelled or computed, `emulate` in a mode other than zsh, a store into `options` or `ARGV0`), with its own reason. The walk gains `ExtractOptions.refuseGlobSubst` and `GlobSubstError`; `canonicalShell` reads `zsh-static` as zsh (TP-3178).
