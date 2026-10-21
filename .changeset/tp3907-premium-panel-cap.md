---
"@titan-design/review-panel": minor
---

`planPanel` caps premium seats by price class: `fable-reviewer` joins `bd-reviewer` in `DEFAULT_SONNET_FOR`, so a Fable member takes the one premium seat and is priced at premium points. A `ShapeRule` with `uncapped: true` keeps its premium profile beside the capped seat (headroom still lowers it). `PanelPolicy.installed` lets the caller say which profiles exist; a premium member lowered to one that does not throws `UninstalledProfileError` at plan time. Because `aggregate` reads the same default table, a g10 correctness member at `fable-reviewer` now counts as premium for `satisfiesG10`.
