---
"@titan-design/tool-guard": patch
---

Classify a command substitution inside an array subscript of a variable's value that arithmetic evaluates: `X='a[$(git push origin HEAD:main)]'; (( X ))`, `let X`, `$(( X ))` and `[[ X -eq 0 ]]` now classify the push. Chains of names are followed up to a fixed cap; a value from `read` or input stays unresolved.
A value arithmetic surely reads whose substitutions cannot all be walked (an unlexable script inside it, or the walk budget spent) now refuses the line as the same text written inline does, instead of classifying nothing. A name only a `[[ -n ]]`-style test mentions is still dropped.
