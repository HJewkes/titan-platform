---
"@titan-design/explainer": patch
---

Store the rejected candidate in the rewrite report. Each `rejected` entry that the guard turned down now carries `candidate: { spoken, labels_added }`, the text the model proposed (spelled for the voice), so a rejection rule such as `number-invented` can be diagnosed from the report. A `missing` entry has no candidate.
