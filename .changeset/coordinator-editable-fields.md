---
"@titan-design/coordinator": patch
---

Add `EDITABLE_FIELDS`, the allowlist of config fields an editor may change (path pattern, bounds, reload class), with `editableField` and `checkEditableValue`. A path no row matches, such as a seat's `grants_extra`, is not editable.
