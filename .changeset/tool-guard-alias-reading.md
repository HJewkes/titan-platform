---
"@titan-design/tool-guard": patch
---

`extractCommands` takes an `aliases` table and reads an aliased command word as its expansion beside the as-written reading, so `g push` with `g=git` yields a `git push` command.
