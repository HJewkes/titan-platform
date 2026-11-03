---
"@titan-design/factory": patch
---

The factory database gains the v9.1 marker table at migration 49: `factory_marker` (one append-only row per item, fact, pin class and pin, with version and digests as columns, and a reverted `landed` marker that ends its item), `factory_marker_blob` for read values and outputs, and `factory_marker_root` for eval roots. Nothing writes or reads it yet.
