---
"@titan-design/factory": minor
---

The visual tier's pixel path: when `shepherd.visualTier[repo].prVisual` names a workflow and a head changes a rendered path, Shepherd downloads that workflow's `pr-visual-<head>` artifact, reads it under byte, entry, shot and pixel caps, and counts changed pixels on every before and after pair itself. Zero on every shot is tier 1 (no-pixel-diff); a changed shot, an artifact at another head or from another workflow, `rendered: false`, a dropped one-sided shot or anything over a cap is tier 2.
