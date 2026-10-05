---
"@titan-design/decider": minor
---

`recommendsAuto` takes the category's overrule count and returns false at `DEMOTE_OVERRULES` (2) or more in the demotion window, so `score` no longer recommends `auto` for a category it flags for demotion, before or after `applyDemotions` runs. Callers of `recommendsAuto` must now pass `overrules`.
