---
"@titan-design/explainer": patch
---

Cap the `register:numbers-per-beat` row at a crowded-beat share of 24% instead of zero crowded beats. The row's value is now crowded beats over beats, `detail_beats` still lists the crowded beats, and a script under the register word floor reports the share but never warns.
