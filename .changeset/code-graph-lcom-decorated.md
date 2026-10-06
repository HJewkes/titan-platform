---
"@titan-design/code-graph": patch
---

LCOM metrics now score decorated Python methods (skipping only `@staticmethod` and `@classmethod`) and count abstract TypeScript classes and class expressions, taking the class node types from a shared `TS_CLASS_TYPES` set in scope-path.
