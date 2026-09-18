---
"@titan-design/style-analyzer": patch
---

Fix two bugs inherited from codewatch's analyzer. Both change aggregated output.

- `STABILITY_MAP` is now keyed by the observation types the extractors actually emit
  (TP-172). The old keys used taxonomy spellings such as `naming.variables`,
  `controlFlow.guardClauses` and `errorHandling.tryCatchFrequency`. Thirty of the 49
  emitted types matched no key and fell back to `medium`. Fourteen of them are now `high`,
  so their confidence is `consistency` instead of `consistency * 0.85`, and their severity
  can rise. They are `naming.variable`, `.function`, `.type`, `.constant`, `.enum` and
  `.private-member`; `control-flow.guard-clause`, `.array-method` and `.async-await`;
  `documentation.jsdoc-presence`; and `error-handling.try-catch`, `.result-type`,
  `.exhaustive-switch` and `.assert-never`. The other sixteen keep `medium`: thirteen have
  an explicit `medium` rating now, and three are listed as unrated on purpose. Keys
  that no extractor emits were removed.
- Python module-level `SCREAMING_SNAKE` assignments, including annotated and chained ones,
  are now classified as `naming.constant` instead of `naming.variable` (TP-173).
