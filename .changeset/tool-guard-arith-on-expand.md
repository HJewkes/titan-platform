---
"@titan-design/tool-guard": patch
---

The lexer refuses math that writes a protected parameter at a `$`: a `$(( ))` or `$[ ]` body, a `${a[…]}` subscript and a bash `${x:off}` or `${x:off:len}` offset, and any math body the guard cannot read to a close it pairs, at a window edge or past a nested unit. The lexer also refuses a `$(( ))` or `$[ ]` it closes elsewhere than the guard's scan did, and a brace splice onto a `$[` group. `assignedInMath` and `mentionedIn` take the set of names to look for, defaulting to the hooked names.
