---
"@titan-design/active-work": patch
---

The CLI builder now projects each command's zod schema through `@titan-design/registry`'s commander helpers instead of its own copies.

Comma-splitting of array flags is gone. Pass an array flag once per value: `--tags a --tags b`. A value that contains a comma is now refused with exit 64 and an error that shows the repeated form, for example `--tags a,b: pass --tags a --tags b`, so an old-style `--tags a,b,c` fails before anything is written instead of storing one wrong tag. This applies to every array flag: `task add` `--tags`/`--dep`/`--deliverable`, `task edit` `--dep`/`--remove-dep`/`--deliverable`, `note add --tags`, `deliverable add --tags`, `deliverable list --tag`, `facet add --tags`, `context related --exclude` and `discover` `--github-repos`/`--local-repos`. Their help text now says "Repeat the flag for each value", and the README and skill examples use the repeated form.

`facet add --tags`, the one required array flag, now keeps every occurrence instead of only the last.

A `.default()` positional is shown as optional, so `edit <slug> [target]` no longer demands a target it already defaults.
