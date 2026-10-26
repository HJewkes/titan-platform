---
"@titan-design/explainer": minor
---

Add type profiles v0 (TP-2746): `doctrine/types/` holds repo-tour (the explain-repo default), repo-argument, pr-overview, paper-summary and daily-overview, and `doctrine/audiences/` the owner-internal and public-youtube packs. `loadProfiles` and `profileFor` reject an unknown profile, and `checkProfiles` checks vocabulary, structure, `mayRepeat` / `mustVary` and the publish guards. `chapterOrder` gives the tour's fixed chapter order and the story-structure heuristic's order for the others. `explainer guide types` generates `guides/planner/<type>.md`.
