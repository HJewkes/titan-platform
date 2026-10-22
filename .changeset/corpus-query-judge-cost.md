---
"@titan-design/corpus-query": patch
---

Cut judge cost: prompt caching off for judge calls, a failed screen batch is redone on haiku before the sonnet fallback, and batch messages label passages `P1`…`Pn` instead of full passage ids.
