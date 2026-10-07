---
"@titan-design/code-graph": patch
"@titan-design/style-analyzer": patch
---

Share the function node-kind sets: code-graph exports `TS_FUNCTION_AND_METHOD_DECL_TYPES` and `PY_FUNCTION_TYPES` from `./analysis`, and style-analyzer's complexity extractor imports them instead of restating them. No behaviour change.
