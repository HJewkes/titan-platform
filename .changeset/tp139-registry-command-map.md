---
"@titan-design/registry": minor
---

Add `CommandMapOf<T>`, a type-only helper that derives the `CommandMap` a typed client is generic over from commands keyed by name (TP-139). Browser code imports the result with `import type`, so neither zod nor registry reaches its bundle.
