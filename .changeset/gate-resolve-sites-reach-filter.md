---
"@titan-design/factory": patch
---

The gate-resolve-sites check now scans only files whose imports reach a resolve sink: a file that reaches none can name no sink, so the closure it finds is unchanged. Test support only; no production code changes.
