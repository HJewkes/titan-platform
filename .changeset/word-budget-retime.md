---
"@titan-design/explainer": patch
---

The script stage re-times a beat a few words over its word cap at no cost: it gets the seconds its words need, at most 2 s more, within the 20 s beat band, its block's longest airtime and the profile's longest runtime, and only when the draft then fails a strict subset of its plan faults. It runs before the plan retry counts faults, so a draft that only needs seconds makes no retry, and again after the last repair round. Each move is a stage note and the reported check `word-budget-retime`. The script stage version moves to x10.
