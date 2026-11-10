---
"@titan-design/session-analytics": patch
---

The timeline bundle test now also asserts that count-at-or-before.ts is among the esbuild inputs, so an emptied entry fails it. Test only; no production code changes.
