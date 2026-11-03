---
"@titan-design/explainer": patch
---

A render refused by its in-process qa now keeps `qa.json` as the `qa-report` artifact of the failed render record. The failure note lists each held row (kind, beat, first ts, element) and names the artifact's sha, instead of pointing at a scratch directory that is already deleted.
