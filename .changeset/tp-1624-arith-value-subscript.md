---
"@titan-design/tool-guard": patch
---

Classify a command substitution inside an array subscript of a variable's value that arithmetic evaluates: `X='a[$(git push origin HEAD:main)]'; (( X ))`, `let X`, `$(( X ))` and `[[ X -eq 0 ]]` now classify the push. Chains of names are followed up to a fixed cap; a value from `read` or input stays unresolved.
