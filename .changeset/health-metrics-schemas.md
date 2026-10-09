---
"@titan-design/health": minor
---

Add the `./metrics` subpath: zod schemas for `titan.metrics/v1` registry entries and `titan.measurement-audit/v1` reports, plus `validateEntry(input, "write" | "read")`. Write mode refuses unknown keys; read mode keeps them.
