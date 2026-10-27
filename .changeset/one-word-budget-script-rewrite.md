---
"@titan-design/explainer": patch
---

The script stage's `word-budget` gate now counts the words the voice reads: numbers are spelled before the draft is budgeted, as rewrite and resolve read them. A rewrite round reverts a beat whose rewrite takes it, or by growing it its profile block, over a word cap, and reports it as reverted with row `word-budget`. The rewrite stage gains a `word-budget` gate. The script stage version moves to x9 and rewrite to x5.
