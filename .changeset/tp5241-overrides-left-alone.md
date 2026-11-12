---
"@titan-design/factory": patch
---

The consumer bump plan now lists a `@titan-design/*` pair under `pnpm.overrides`, `overrides` or `resolutions` in `leftAlone` with `pinned by <field>` as its reason, so a bump past an old override is visible. Such a pair is still never bumped, and a repo with only such pins gets the left-alone note instead of `current`.
