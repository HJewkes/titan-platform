---
"@titan-design/factory": patch
---

Shepherd's git cache effects (system git with its no-prompt env, the cache fs, the bound state dir) move from `tree-carry.ts` into `carry-cache-adapter.ts`. The carry probes, head-lines, the git PR file read and the stack restack now resolve their cache through `cacheFor` and `ensureCache(cache, signal)`. `CarryOptions.ports` is optional and falls back to the host ports, so behaviour is unchanged.
