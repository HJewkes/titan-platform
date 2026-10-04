---
"@titan-design/factory": patch
---

The review-checkout sweep now matches only `review-<pr>-<12 hex>` directories instead of any `review-*` name in the temp dir. It removes them with async `fs/promises` calls so the daemon loop is not blocked, and `serve` logs a warning with the path and message when an entry cannot be removed.
