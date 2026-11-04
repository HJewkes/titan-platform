---
"@titan-design/factory": patch
---

`CliDeps` no longer takes a `presence` check and `FactoryServerOptions` no longer takes an `ownerKeys` loader, so no composition root can swap the checks that decide who the owner is. `gate resolve` and `shepherd owner-release` always ask `confirmOwner`, and serve always reads the key ring through `loadOwnerKeys`. Tests reach both through their OS edge only: the helper runner, lstat and helper path, and a key directory on disk, set from `test-support/owner-edges.ts`. Behaviour is unchanged.
