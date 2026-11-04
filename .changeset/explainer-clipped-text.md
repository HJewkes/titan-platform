---
"@titan-design/explainer": minor
---

Adds `clippedText`, a pure QA check over measured text lines and every clipping ancestor (painted or not) that reports a `clipped-text` error for each element with a line cut off. It covers a three-line headline in a band sized for two, which the bridge's QA missed because the band had no background (TP-4104).
