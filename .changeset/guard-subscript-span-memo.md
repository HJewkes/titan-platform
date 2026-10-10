---
"@titan-design/tool-guard": patch
---

Read each `$( )` and `${ }` span once when matching an assignment subscript's bracket. A value nesting substitutions inside brackets doubled the scan per level, so a short line outlasted the hook's timeout and the guarded command ran unchecked.
