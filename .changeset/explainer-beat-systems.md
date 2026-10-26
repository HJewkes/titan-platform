---
"@titan-design/explainer": minor
---

Add the per-type beat systems (TP-4007): `doctrine/beat-systems/` holds nine `beat-system/v1` files (`bluf`, `cl-order`, `example-first`, `martini-glass`, `journey-of-attempts`, `chapter-question`, `countdown-rung`, `lab-cycle`, `board-walk`), each an ordered beat pattern that plays inside a structure's blocks. Profiles bind them per macro under `structure.systems`, optionally scoped to blocks. `loadBeatSystems` rejects a system or step beat outside the vocabulary, `beatSystemFor` rejects an unknown system, `placeBeatSystem` lands steps in order, and `checkProfiles` reports an unknown or unplaceable binding. Planner guides list each bound system with its steps.
