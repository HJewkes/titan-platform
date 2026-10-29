---
"@titan-design/explainer": patch
---

Custom layers now pass qa's text rules before they are stored (TP-4418). The page draws a custom layer in the stage box between empty chrome bands, and raises any of its text under the 40 px type floor to the floor. After each layer build, a $0 Chromium check renders the layer at its reveal points and applies qa's `small-text` and `under-chrome` rules and a `bad-text` rule (visible `NaN`, `undefined`, `null`, `[object`). A miss rebuilds the layer once with a hint naming each element and rule; a rebuild that still misses fails resolve with a row per beat, element and rule. The builder doctrine now states that `useBeatTime()` returns an object; reading it as a number was what drew `NaN`. The claude-print worker version (`c3`) and the resolve stage version change, so stored layers rebuild.
