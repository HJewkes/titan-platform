---
"@titan-design/factory": patch
---

Shepherd keep mode now closes a `slices`-tagged task whose plan has no `burndown-slices` block once every slice its plan headings or notes list has landed (TP-4712). A slice the notes move to another task no longer holds the original open, a slice PR registered with `--last-slice` now closes its task, and a slice PR that leaves a task open notes what still holds it.
