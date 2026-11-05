---
"@titan-design/factory": patch
"@titan-design/explainer": patch
---

Source no longer imports carried paths: the A17 report check and single-mode list moved from `test-support/a17/` to `src/a17/`, and the baked page reads `composition/data/baked.timeline.json` instead of a fixture. Structure rule R60 fails when a non-test source file imports a path in `.github/fix-proof.json` tests or carry globs.
