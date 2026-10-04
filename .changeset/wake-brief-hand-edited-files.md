---
"@titan-design/factory": patch
---

Shepherd's conflict wake treats only script-rewritten files as generated (CAPABILITIES.md, site/guides/capabilities.md, site/reference/index.md, the reference sidebar) and names `pnpm capabilities` and `pnpm docs:reference` to regenerate them. Hand-edited reference pages and .codewatch/check.json are hand-merged, never resolved by taking the base's side.
