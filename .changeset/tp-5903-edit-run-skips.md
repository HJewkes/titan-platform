---
"@titan-design/factory": patch
---

Merge facts no longer read a no-op `edited` fix-proof run's skips over the completed real run at the same head, so a title or body edit after push stops failing `required-contexts-green`. A red real run stays red, and any other skip still gates.
