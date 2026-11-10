---
"@titan-design/active-work": patch
---

active-work resolves its data, state, config and cache roots through `@titan-design/app-paths` instead of its own `env-paths` call. A parity test pins the five `ACTIVE_ROOT` cases and the XDG overrides; behaviour is unchanged.
