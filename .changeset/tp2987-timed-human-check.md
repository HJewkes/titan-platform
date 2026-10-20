---
"@titan-design/explainer": minor
---

Add the timed human check kit to `eval-owner`: `prepareTimedSession` writes per-chapter question sheets that match the cold probe's item questions plus a 1-5 overload row, `recordTimedSession` writes the answers to `owner.tsv` under scope `timed:<chapter>` before the key opens, and `compareTimed` reports per-item agreement with the probe and the overload correlation per chapter.
