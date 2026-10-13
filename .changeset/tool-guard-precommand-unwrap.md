---
"@titan-design/tool-guard": patch
---

Read zsh's precommand modifiers `noglob`, `nocorrect` and `-` as wrappers, so `noglob git push origin HEAD:main` classifies as a protected push (TP-2716 a).
