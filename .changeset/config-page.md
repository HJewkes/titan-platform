---
"titan-console": patch
---

Add the read-only `#/config` page: every `config.surfaces` row grouped by surface, led by the `config.drift` rows whose copies disagree. A row with a file line shows the exact command that opens that line, with a copy button; a hidden row shows only "present", never a value. The page has no edit control.

The console frame now grows with a long page instead of stopping at the viewport height, so the rail runs the full length of every page.
