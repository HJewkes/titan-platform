---
"@titan-design/factory": minor
---

`service deploy` now fast-forwards and builds a dedicated checkout, `service.deployCheckout` or `<app data dir>/deploy/titan-platform`, that no agent or coordinator uses as its cwd. An absent checkout is cloned from `service.deployRemote` (default: the CLI checkout's origin), built, and left for `service install`, which renders the unit to run serve from it with `WorkingDirectory` set. `service install` refuses until the deploy checkout has a built bin. One-time migration: run `service deploy`, then `service install`.
