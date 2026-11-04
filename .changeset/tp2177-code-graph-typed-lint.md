---
"@titan-design/code-graph": patch
---

Narrow stored JSON and thrown errors instead of asserting them, and drop tree-sitter child guards that 0.26 cannot reach. A stored finding that is not a `Finding` is now skipped, and non-object `attrs` read as empty.
