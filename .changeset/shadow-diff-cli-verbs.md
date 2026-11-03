---
"@titan-design/factory": patch
---

Add `markers shadow-diff` and `markers shadow-gate`: the SHD-2 disagreement counts per family, class and cause, and the 48 h exit gate that exits 1 when blocked. Both open the database read-only and never turn the shadow off. The `shadow-diff` directory is added to the sunset manifest as a `delete` root for D-M8-09.
