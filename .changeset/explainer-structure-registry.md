---
"@titan-design/explainer": minor
---

Add the narrative structure registry (TP-4006): `doctrine/structures/` holds fifteen `narrative-structure/v1` structures, each with a fit predicate over material signals, airtime shares and its own spine sections. `design-journey` replaces `guides/spine-template.md`, and owner-FB1 is scoped to it. `loadStructures` and `structureFor` reject an unknown structure, and `checkStructures` checks vocabulary, signals, shares and blocks. `chapterOrder` now takes the structures and asks their fit predicates; heuristic profile rows drop `signal` and `minRuntimeS`, and `ChapterOrder.signal` becomes `fallback`. Type guides list each structure a profile may pick.
