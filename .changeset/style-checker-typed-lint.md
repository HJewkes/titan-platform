---
"@titan-design/style-checker": patch
---

Parse ESLint, ruff and pyright JSON output with zod and narrow caught errors instead of casting, so a malformed tool report fails at the boundary. Internal typed-lint cleanup; the public API is unchanged.
