---
"@titan-design/tool-guard": patch
---

Classify a command substitution inside an array subscript of a variable's value that arithmetic evaluates: `X='a[$(git push origin HEAD:main)]'; (( X ))`, `let X`, `$(( X ))` and `[[ X -eq 0 ]]` now classify the push. Chains of names are followed up to a fixed cap; a value from `read` or input stays unresolved.
A value arithmetic surely reads whose substitutions cannot all be walked (an unlexable script inside it, a chain of names past the cap, or the walk budget spent) now makes the hook deny the line, instead of classifying nothing. `[[ ]]` split by `&&` or `(`, `declare -i Y=X` and a `X=… let X` prefix are read as arithmetic too. A name only a `[[ -n ]]`-style test mentions is still dropped.
