---
"titan-console": minor
---

`titan-console rounds import` copies a frames@1 record's `targets` element map (`targets: { file, sha256 }` from TP-3773 S5b; TP-3856) beside its PNG. The file goes through the same reader and copy loop as the PNGs: a relative `.json` path inside the round of at most 256 KiB, no symlink at any component, sha256-checked against the record before anything is written and again as it is copied. A record that names no `targets` imports as before. `rounds.frameTargets` now reads through that same reader, with unchanged checks and refusals.
