---
"@titan-design/tool-guard": patch
---

Read zsh's precommand modifiers `noglob`, `nocorrect` and `-` as running the builtin after them in the current shell: a `read`, `printf -v` or declarer behind one is read like one behind `command` (TP-2716 b).
