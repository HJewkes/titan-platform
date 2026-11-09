---
"@titan-design/active-work": patch
---

The CLI builder now projects each command's zod schema through `@titan-design/registry`'s commander helpers instead of its own copies. Comma-splitting of array flags is gone: pass an array flag once per value (`--tags a --tags b`), because `--tags a,b` now yields the single value `a,b`. Array values are no longer trimmed or stripped of empty entries. A `.default()` positional is now shown as optional (`[name]`).
