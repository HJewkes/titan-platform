---
"@titan-design/eslint-plugin": patch
---

- **Stop `no-test-clock-budget` overflowing the stack on a parent walk (TP-4264).** A name written from its own property, as in `parent = parent.parentElement`, was followed one property deeper each time, so linting such a test threw a RangeError. The rule now stops following a name past eight properties, deeper than any clock reading is read.
