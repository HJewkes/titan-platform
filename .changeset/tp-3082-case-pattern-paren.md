---
"@titan-design/tool-guard": patch
---

Read a case-pattern `)` inside `$( )` as a pattern end, not the end of the substitution. `echo $(case x in a) git push;; esac)` ended the substitution at `a)` and left the command after it unread by the guard; it is now refused.
