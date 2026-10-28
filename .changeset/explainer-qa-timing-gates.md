---
"@titan-design/explainer": minor
---

The qa stage runs the DIRECTION timing gates (TP-2669) and gates `picture-change` (fails above
`pictureChangeFailS`, 8 s by default; `picture-change-warn` reports a gap above `pictureChangeMaxS`), `static-window`,
`cue-onset` and `reading-hold`, and reports the spike's G1, G7, G8, G9, G10, G12 and G13 as `direction-gates`.
Thresholds come from the type profile's `pacing`, which gains the optional `pictureChangeFailS`, `cueOnsetS`,
`readingCps` and `readingMinS`. `qa.json` gains `timing` with each gate, `static_window_count` and
`picture_change_gap_max`.
