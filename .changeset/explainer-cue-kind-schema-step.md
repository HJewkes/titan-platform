---
"@titan-design/explainer": patch
---

The script stage now rejects a reply whose cue target names a kind outside the cue-kind table, and the schema retry names the kind and the beat. The item track no longer throws on such a cue: it counts the cue as an item and keeps its kind.
