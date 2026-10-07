---
"@titan-design/code-read": patch
---

Fill the new `loc` field on symbol-grain hotspot rows from `symbol_loc`, so `code-read` keeps typechecking against `@titan-design/code-graph` rows that now carry `loc`.
