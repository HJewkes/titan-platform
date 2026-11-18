---
"@titan-design/active-work": patch
---

Add `task edit --clear <field>` to remove due, kind, cos, area, parent or bet from a task. Clearing an absent field is a notice, clearing due on a cos fixed task is refused, and `--clear` with a set flag for the same field is a usage error.
