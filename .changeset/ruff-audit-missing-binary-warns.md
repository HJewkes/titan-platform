---
"@titan-design/style-checker": patch
---

`runRuffAudit` now runs through the shared Python audit runner: with ruff absent it returns no failures and the warning ``ruff not found; install with `pip install ruff` ``, as the other audit runners do, and `failures[].file` is relative to `cwd` like the diagnostics.
