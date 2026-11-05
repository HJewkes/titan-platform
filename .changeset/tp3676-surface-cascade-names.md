---
"@titan-design/code-graph": patch
---

A seeded index no longer re-extracts every importer of a file whose export surface changed. When the change only adds or removes named exports, an unchanged importer re-extracts only if it holds an edge to a changed symbol, writes a changed name, or imports the module whole. Removed files, re-export changes and default exports still re-extract every importer (TP-3676).
