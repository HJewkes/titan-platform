---
"@titan-design/code-graph": patch
---

`packageEntryFileIds` no longer throws when an existing tsconfig cannot be read; it treats the file as absent and keeps the dist-to-src fallback, as it already does for an unreadable `package.json`.
