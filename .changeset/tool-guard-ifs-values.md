---
"@titan-design/tool-guard": patch
---

Add `lineIfsValues`, which gathers bash's default IFS and every literal IFS value a line assigns, including declarer arguments, `for IFS in` lists and `eval` or `sh -c` text. It gives null when the line writes IFS in a way it cannot resolve to a literal, runs dynamic or sourced shell text, or holds a dynamic name in arithmetic (TP-2729 a); not wired yet.
