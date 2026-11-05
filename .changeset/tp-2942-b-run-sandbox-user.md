---
"@titan-design/fix-proof": minor
---

`run()` takes `sandboxUser` and `fix-proof run` takes `--sandbox-user <name>`, validated as `exec` does. Both sides run sandboxed, and head code cannot open the judge's snapshot, which stays in a runner-owned 0700 dir.
