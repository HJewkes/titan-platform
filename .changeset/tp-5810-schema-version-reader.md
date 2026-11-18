---
"@titan-design/active-work": patch
---

Read `.schema-version` through one reader: `readSchemaVersion` now delegates to `readRawSchemaVersion` and applies the zero rule once (TP-5810).
