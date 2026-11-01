---
"@titan-design/code-graph": patch
---

`indexPaths` no longer re-parses every byte-identical file that imports through a barrel or imports a stylesheet whenever a file is added or removed. The membership-delta check now compares how a relative specifier resolves before and after the delta, not against the stored edge target, which for those edges never matched.
