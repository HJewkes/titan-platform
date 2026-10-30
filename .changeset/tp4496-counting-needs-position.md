---
"@titan-design/explainer": patch
---

QA no longer treats a number as a counting figure when its element has no probed line box. Without a position, siblings of one element could not be told apart from one figure whose value changes, so a changing number went unjudged (TP-4496). The qa stage is bumped to `x11d`.
