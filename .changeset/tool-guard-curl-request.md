---
"@titan-design/tool-guard": patch
---

curl and wget requests read a dynamic method as `UNKNOWN`; `-K`/`--config`, a templated `--expand-*` value and `--request-target` make the method unknown and add a run-time URL; quoted URL globs expand as curl expands them (unless `-g`), and one that cannot be expanded is a run-time URL; the request keeps its literal body texts, or null when a body is read from a file or known only at run time (TP-2735 c).
