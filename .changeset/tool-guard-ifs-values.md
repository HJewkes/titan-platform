---
"@titan-design/tool-guard": patch
---

Add `lineIfsValues`, which gathers bash's default IFS and every literal IFS value a line assigns, including declarer arguments, `for IFS in` lists and `eval` or `sh -c` text (TP-2729 a); not wired yet.
