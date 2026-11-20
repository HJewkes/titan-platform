---
"@titan-design/code-graph": minor
---

A Python module id now ends in `@py` instead of dropping the extension (TP-308): `src/sample.py` belongs to module `src/sample@py`, while `src/sample.ts` keeps `src/sample`. Before, a `.ts` and a `.py` file with the same stem shared one module node, and its language came from whichever file merged last. TypeScript module ids, file ids and symbol ids are unchanged. Rules or views that matched Python module ids by their bare stem must add the `@py` tag. `INDEX_VERSION` moves to 0.36.0, so stored indexes with the old ids are not reused.
