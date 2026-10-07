---
"@titan-design/code-graph": minor
"@titan-design/code-read": patch
---

Add a `no-import-cycles` check rule to code-graph. It reports each strongly connected component of the file import graph once, with its sorted member files in the new `members` field, and leaves type-only imports out unless `includeTypeOnly: true`. Against a baseline, a cycle inside one known cycle carries over and a cycle that gains a file is new. The TypeScript extractor now marks type-only import and re-export edges with `attrs.typeOnly`, and `INDEX_VERSION` moves to 0.25.0 so no snapshot without that mark is reused. code-read describes the new rule in plain language.
