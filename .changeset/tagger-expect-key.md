---
"@titan-design/explainer": patch
---

Include the planted control's expected role in the tagger batch key (TP-5110), so changing only `expect` re-tags instead of replaying a stale memoised batch.
