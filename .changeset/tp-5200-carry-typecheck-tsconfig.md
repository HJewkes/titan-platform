---
"@titan-design/fix-proof": patch
---

Pin the repo config's handling of a typecheck-only tsconfig: `**/tsconfig.typecheck.json` is carried test support, a build `tsconfig.json` stays source, and a runtime glob still overrides carry. Test only; no production code changes.
