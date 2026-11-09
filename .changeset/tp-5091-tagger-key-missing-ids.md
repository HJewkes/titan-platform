---
"@titan-design/explainer": patch
---

The tagger's batch key now hashes the rendered prompt and the chosen control, so an edited excerpt re-tags instead of replaying a stale answer. `TagFactsResult.missing` lists fact ids a schema-valid reply left untagged.
