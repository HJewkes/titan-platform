---
"@titan-design/worktree": minor
---

The git env pins no longer export the full protocol list, which outranked a caller's own `protocol.*.allow` denies (CC-1336). `pinGitProtocols` now returns `undefined` (leave GIT_ALLOW_PROTOCOL unset) for an unset value or the legacy `file:git:http:https:ssh`, and still intersects any other caller list with the safe list. `withPinnedGitProtocols`, `gitChildEnv` and `setupEnv` append `protocol.ext.allow=never` as the last `GIT_CONFIG_COUNT` pair, after `gitChildEnv`'s prefix stripping, keep caller pairs, and throw on a count git would die on.
