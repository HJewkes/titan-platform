---
"@titan-design/code-graph": patch
---

Tighten component prop metrics. An inner binding that shadows a prop name is no longer a read of that prop, a parenthesized `(boolean | undefined)` member counts as bool, an interface that extends only imported types is absent like an all-imported `&` intersection, and PascalCase class methods and getters are not scored as components. `FC<P>` and `Readonly<P>` are not unwrapped, so their props stay absent.
