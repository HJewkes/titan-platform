---
"@titan-design/tool-guard": patch
---

Read a `read` or `printf -v` name operand behind zsh's precommand modifiers `noglob`, `nocorrect` and `-` like one behind `command`, so a subscripted or run-time name is read as arithmetic (TP-2716 b). A readonly behind them is not marked sure.
