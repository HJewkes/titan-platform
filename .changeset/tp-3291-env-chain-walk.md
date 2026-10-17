---
"@titan-design/tool-guard": patch
---

Read a chain of envs that `-S` strings supply (`env -S env -S …`, `env -S 'env env …'`) in one walk, so the line is rebuilt once rather than once per env.
