---
"@titan-design/explainer": minor
---

Adds the 6×6 anchor grid and the per-mark occupancy table (TP-4015). `anchorsForBox`, `expandAnchors` and `placeSlots` address the frame by anchor, `buildOccupancy` maps each settled mark's anchors to element ids (DOM, declared custom-layer anchors, or the pixel 6×6 fallback), `collisions`, `emptySpace` and `anchorFindings` read it, and `writeOccupancy` writes `occupancy.json` next to `qa.json`. A script's `visual.anchors` now also takes a `B2:E5` range.
