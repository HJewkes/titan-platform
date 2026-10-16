---
"@titan-design/tool-guard": patch
---

Read a case-pattern `)` inside `$( )` as a pattern end, not the end of the substitution. `echo $(case x in a) git push;; esac)` ended the substitution at `a)` and left the command after it unread by the guard; it is now refused.

Read `case` and `esac` by bash's grammar position. A `case` that opens a pattern body now nests, a pattern word such as `(esac)` no longer closes its case, and a pattern's parens leave the paren depth alone, so it no longer goes below 0. An `esac` with no open case, or one inside a block in a body, leaves the case unclosed, so the guard refuses it.
