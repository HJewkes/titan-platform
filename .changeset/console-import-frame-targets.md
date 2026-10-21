---
"titan-console": minor
---

`titan-console rounds import` copies a frames@1 record's `targets` element map (`targets: { file, sha256 }`, TP-3856) beside its PNG. The file goes through the same reader and copy loop as the PNGs: a relative `.json` path inside the round of at most 256 KiB, no symlink at any component, sha256-checked against the record before anything is written and again as it is copied. A record that names no `targets` imports as before. The frames@1 schema gains the optional record field `targets`; a malformed one is dropped, not refused.
