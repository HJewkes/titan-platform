---
"@titan-design/tool-guard": patch
---

The lexer refuses math that writes a protected parameter at a `$`: a `$(( ))` or `$[ ]` body, a `${a[…]}` subscript and a bash `${x:off}` or `${x:off:len}` offset, and a math body that does not close within the read window. `assignedInMath` and `mentionedIn` take the set of names to look for, defaulting to the hooked names.
