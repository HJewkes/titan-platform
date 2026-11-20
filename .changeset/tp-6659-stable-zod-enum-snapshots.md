---
---

API snapshots order each zod enum's members by name, so a rebuild that emits them in another order leaves the snapshot alone. No package source changes; only the committed api/ snapshots are reordered.
