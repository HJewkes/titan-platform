---
"@titan-design/retrieval-eval": patch
---

Take the `--active-root` and `--graph` defaults from `@titan-design/app-paths`, so they follow `ACTIVE_ROOT` and resolve off macOS. `defaultActiveRoot` and `defaultGraphPath` are removed; use `activeWorkRoot` and `activeWorkGraphPath` from `@titan-design/app-paths`.
